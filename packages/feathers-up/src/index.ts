import configuration from '@feathersjs/configuration'
import express, {Application as ExpressApplication, errorHandler as expressErrorHandler, json as expressJson, notFound as expressNotFound, rest as expressRest, RestOptions, urlencoded} from '@feathersjs/express'
import {feathers} from '@feathersjs/feathers'
import socketio from '@feathersjs/socketio'
import * as Sentry from '@sentry/node'
import setHooks from '@snickbit/feathers-hooks'
import logs from '@snickbit/feathers-logs'
import {Model} from '@snickbit/model'
import {findUp} from '@snickbit/node-utilities'
import {Out} from '@snickbit/out'
import {isArray, isFunction, isObject, objectCopy} from '@snickbit/utilities'
import compress from 'compression'
import cors, {CorsOptions} from 'cors'
import helmet, {HelmetOptions} from 'helmet'
import Redis from 'ioredis'
import knex from 'knex'
import KnexMysql from 'knex/lib/dialects/mysql'
import {ray} from 'node-ray'
import path from 'path'
import {OptionsJson, OptionsUrlencoded} from 'body-parser'
import {RequestHandler} from 'express'
import Logger from '@snickbit/feathers-logger'
import {ZlibOptions} from 'zlib'
import {ServerOptions} from 'socket.io'

export interface CompressOptions extends ZlibOptions {
	filter?: () => boolean
	threshold?: number
}

export interface AppSetupExpress {
	json?: OptionsJson
	urlencoded?: OptionsUrlencoded
	rest?: RestOptions | RequestHandler
	express?: {
		notFound: {
			verbose: boolean
		}
	}
	errorHandler: {
		html: boolean,
		logger: Out
	}
}

export interface AppSetup {
	paths?: AppSetupPaths
	helmet?: Partial<HelmetOptions>
	cors?: CorsOptions
	compress?: CompressOptions
	express?: AppSetupExpress
	socketio?: ServerOptions
	middleware?: (...args) => any
	authentication?: (...args) => any
	services?: (...args) => any
	channels?: (...args) => any
	hooks?: (...args) => any
}

export type AppSetupPaths = {
	root?: string;
	storage?: string;
	uploads?: string;
	temp?: string;
};

export interface FeathersUpOverrides {
	out: Out;
	log: typeof Logger;
	error: typeof Logger;
}

export interface Application extends ExpressApplication {
	out: Out;
	log: typeof Logger;
	error: typeof Logger;
}

let app: Application

export function useApp(appType = 'server', setup: AppSetup = {}) {
	if (app) return app
	else return feathersUp(appType, setup)
}

export function feathersUp(appType = 'server', setup: AppSetup | Model = {}): Application {
	if (app) return app

	setup = new Model(setup)

	let instance = feathers()
	instance = appType === 'cli' ? instance : express(instance) as ExpressApplication

	app = instance as Application

	app.set('appType', appType)
	app.set('env', process.env.NODE_ENV || 'development')

	app.out = new Out(appType)
	app.out.block.info(`Initializing {cyan}${appType}{/cyan} in {magenta}${app.get('env')}{/megenta} mode`)

	process.on('unhandledRejection', (reason, promise) => {
		ray('unhandledRejection', reason)
		app.error.log('Unhandled Rejection: ', reason)
		promise.then(response => {
			ray().toJson(response)
			app.error.log(response)
		}).catch(err => {
			ray().error(err.data)
			app.error.log(err)
		})
	})

	// Load app configuration
	app.out.verbose('Load app configuration...')
	app.configure(configuration())

	// Check path configuration
	let paths = app.get('paths') || setup.get('paths')
	if (!paths) {
		paths = {
			root: path.dirname(findUp('package.json', {cwd: process.cwd()}) || '.')
		}
		paths.storage = path.resolve(path.join(paths.root, '..', 'storage'))
		paths.uploads = path.join(paths.storage, 'uploads')
		paths.temp = path.join(paths.storage, 'temp')
		app.set('paths', paths)
	}

	// Load package.json info
	/* eslint @typescript-eslint/no-var-requires: off */
	const packageJson = require(path.join(paths.root, 'package.json'))
	app.set('name', packageJson.name)
	app.set('version', packageJson.version)
	app.set('description', packageJson.description)

	// load system configuration
	const system = {
		logs: app.get('logs') || setup.get('logs')
	}

	// Check config for embedded plugins
	const plugins = {
		sentry: app.get('sentry')
	}

	// check for databases
	const databases = {
		mysql: app.get('mysql'),
		redis: app.get('redis'),
		mongodb: app.get('mongodb')
	}

	if (system.logs === true || system.logs?.driver === 'feathers-logger') {
		try {
		app.configure(logs)
		app.log.context({app_type: appType, app: app.get('name'), version: app.get('version')})
		app.log.info('Initializing App')
		} catch {
			app.out.error('Failed to initialize logger')
		}
	}

	app.out.debug(objectCopy(app.settings), {paths})
	if (plugins.sentry) {
		Sentry.init({
			dsn: plugins.sentry.dsn,
			environment: process.env.NODE_ENV
		})

		if (appType === 'server') {
			app.out.verbose('Enable sentry request handler')
			app.use(Sentry.Handlers.requestHandler())
		}
	}

	// Setup database connections

	if (databases.mysql) {
		app.out.verbose('Connect to mysql databases...')
		if (isArray(databases.mysql)) {
			for (let mysqlDb of databases.mysql) {
				app.set(`mysqlClient.${mysqlDb.database}`, knex({
					client: KnexMysql,
					connection: mysqlDb
				}))
			}
		} else {
			app.set('mysqlClient', knex({
				client: 'mysql',
				connection: databases.mysql
			}))
		}
	}

	if (databases.redis) {
		app.out.verbose('Connect to redis databases...')
		if (isArray(databases.redis)) {
			for (let redisDb of databases.redis) {
				app.set(`redisClient.${redisDb.keyPrefix}`, new Redis(redisDb))
			}
		} else {
			app.set('redisClient', new Redis(databases.redis))
		}
	}

	// server configuration
	if (appType === 'server') {
		app.out.verbose('Enable security, CORS, compression, favicon and body parsing...')
		app.use(helmet(setup.get('helmet') || {contentSecurityPolicy: false}))
		app.use(cors(setup.get('cors')))
		app.use(compress(setup.get('compress')))
		app.use(expressJson(setup.get('express.json')))
		app.use(urlencoded(setup.get('express.urlencoded') || {extended: true}))

		app.out.verbose('Set up Plugins and providers...')
		app.configure(expressRest(setup.get('express.rest')))
		app.configure(socketio(setup.get('socketio')))

		app.out.verbose('Configure middleware')
		if (setup.has('middleware')) {
			try {
			app.configure(setup.get('middleware'))
			} catch (e) {
				app.out.error('Error configuring middleware', e)
			}
		}

		app.out.verbose('Configure authentication')
		if (setup.has('authentication')) {
			try {
			app.configure(setup.get('authentication'))
			} catch (e) {
				app.out.error('Error configuring authentication', e)
			}
		}
	} else if (app.get('queue')) {
		// ensure the queue worker/watcher is NOT running in CLI mode
		const queue = app.get('queue')
		if (!isObject(queue.watcher)) {
			queue.watcher = {enabled: false}
		} else {
			queue.watcher.enabled = false
		}

		if (!isObject(queue.worker)) {
			queue.worker = {enabled: false}
		} else {
			queue.worker.enabled = false
		}
		app.set('queue', queue)
	}

	if (setup.has('services')) {
		app.out.verbose('Set up services')
		try {
		app.configure(setup.get('services'))
		} catch (e) {
			app.out.error('Error configuring services', e)
		}
	}
	if (setup.has('channels')) {
		app.out.verbose('Set up event channels')
		try {
		app.configure(setup.get('channels'))
		} catch (e) {
			app.out.error('Error configuring channels', e)
		}
	}

	if (appType !== 'cli') {
		app.out.verbose('Configure status route')
		app.use('/status', (req, res) => res.json({status: 'ok'}))

		if (setup.has('hooks')) {
			app.out.verbose('Set up hooks')
			const hooks = setup.get('hooks')
			if (hooks) {
			if (isFunction(hooks)) {
				app.configure(hooks)
			} else if (isObject(hooks)) {
				setHooks(app, hooks)
			}
		}
		}

		if (plugins.sentry) {
			app.out.verbose('Configure sentry error handler')
			app.use(Sentry.Handlers.errorHandler())
		}
		app.out.verbose('Configure a middleware for 404s and the error handler')
		app.use(expressNotFound(setup.get('express.notFound') || {verbose: process.env.NODE_ENV !== 'production'}))
		app.use(expressErrorHandler(setup.get('express.errorHandler') || {
			html: false,
			logger: app.error.log
		}))
	}

	return app
}

export default feathersUp