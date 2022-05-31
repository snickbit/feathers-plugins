import {AdapterBase, filterQuery, PaginationOptions} from '@feathersjs/adapter-commons'
import {NotFound} from '@feathersjs/errors'
import {Application, Id, NullableId, Paginated, Params, Query} from '@feathersjs/feathers'
import {filterParams} from '@snickbit/feathers-helpers'
import {Out} from '@snickbit/out'
import {merge, objectExcept} from '@snickbit/utilities'
import {ExistingDocument, PostDocument, PouchDatabase, PouchServiceOptions, PutDocument} from './definitions'
import {PouchError} from './PouchError'
import pouchCrypt, {PouchCrypt} from './PouchCrypt'
import PouchDB from 'pouchdb'
import pouchdb_find from 'pouchdb-find'
import pouchdb_adapter_memory from 'pouchdb-adapter-memory'

PouchDB.plugin(pouchdb_find)
	.plugin(pouchCrypt)
	.plugin(pouchdb_adapter_memory)

const possibleOptionKeys = [
	'pouch',
	'pouchdb',
	'couch',
	'couchdb'
]

function checkAppForOptions(app: Application) {
	for (const key of possibleOptionKeys) {
		if (app.get(key)) {
			return app.get(key)
		}
	}
	return {}
}

export interface PouchAdapter extends AdapterBase, EventEmitter {}

export class PouchAdapter<T = any, P extends Params = Params, O extends PouchServiceOptions = PouchServiceOptions> extends AdapterBase {
	declare options: O

	protected client: PouchDatabase<Document>

	protected remote?: PouchDatabase<Document>

	protected out: Out

	constructor(options: O = {} as O) {
		options = {
			id: '_id',
			events: [],
			paginate: {},
			multi: false,
			filters: [],
			whitelist: [],
			...options
		} as O

		super(options)
	}

	protected isMulti(id: Id, params?: Params): Query | false {
		const {query} = filterQuery(params || {})
		return !id && query && Object.keys(query).length ? query : false
	}

	getQuery(params: P) {
		const {
			$skip,
			$sort,
			$limit,
			$select,
			...query
		} = params.query || {}

		return {
			query,
			filters: {
				$skip,
				$sort,
				$limit,
				$select
			}
		}
	}

	protected filterDocs(docs: any) {
		return docs.filter(doc => !doc._id.startsWith('_'))
	}

	async setup(app: Application, servicePath: string) {
		this.out = new Out(`pouchdb:${servicePath}`)

		this.options = {...checkAppForOptions(app), ...this.options}

		if (this.options.verbosity) {
			this.out.setVerbosity(this.options.verbosity)
		}

		const connection = this.options.connection || {}
		connection.adapter = this.options.encrypt && (this.options.encrypt === 'local' || !this.options.encryptionKey) ? 'memory' : connection?.adapter
		connection.prefix = this.options.prefix || ''

		this.out.debug('Initializing pouchdb', connection)

		this.client = new PouchDB(servicePath, connection) as PouchCrypt<Document>

		this.client.changes({
			since: 'now',
			live: true,
			include_docs: true
		})
			.on('change', change => {
				this.emit('changes.change', change)
			})
			.on('complete', info => {
				this.emit('changes.complete', info)
			})
			.on('error', error => {
				this.emit('changes.error', error)
			})

		this.client.createIndex({index: {fields: [this.options.id]}})

		let replicateFrom = this.client

		if (this.options.encrypt) {
			let encryptionKey: string | false
			try {
				this.out.debug('Waiting for encryption key...')
				encryptionKey = await this.encryptionReady(app)
			} catch (e) {
				const error = new PouchError('Failed to initialize encryption', e)
				this.out.error(error)
				throw error
			}

			if (encryptionKey) {
				this.out.debug('Encrypting data')
				const encryptOptions = objectExcept(connection, ['name'])
				if (this.options.encrypt) {
					this.out.debug('Encrypting remote data', this.options.encrypt, encryptOptions)
					try {
						await this.client.setPassword(encryptionKey, {opts: encryptOptions})
					} catch (e) {
						const error = new PouchError('Failed to encrypt remote data', e)
						this.out.error(error)
						throw error
					}

					// We only need to load the encrypted data if we are using e2e encryption
					if (this.options.encrypt === true || this.options.encrypt === 'remote') {
						this.out.debug('Loading encrypted data')
						try {
							await this.client.loadEncrypted()
						} catch (e) {
							const error = new PouchError('Failed to load encrypted data', e)
							this.out.error(error)
							throw error
						}
					}

					replicateFrom = this.client._encrypted as PouchDatabase<Document>
				}
			}
		}

		if (this.options.replicate) {
			const replication = {...connection, ...this.options.replicate}
			this.out.debug('Initializing replication', {replication})
			this.remote = new PouchDB(servicePath, replication) as PouchDatabase<Document>

			this.out.debug('Starting data replication')
			PouchDB.sync(replicateFrom, this.remote, {live: true, retry: true})
				.on('change', info => {
					this.emit('sync.change', info)
				})
				.on('paused', error => {
					this.emit('sync.paused', error)
				})
				.on('active', () => {
					this.emit('sync.active')
				})
				.on('denied', error => {
					this.emit('sync.denied', error)
				})
				.on('complete', info => {
					this.emit('sync.complete', info)
				})
				.on('error', error => {
					this.emit('sync.error', error)
				})
		}
	}

	private async encryptionReady(app: Application): Promise<string | false> {
		if (!this.options.encrypt) {
			return false
		} else if (this.options.encryptionKey) {
			this.out.debug('Encrypting with preset key')
			return this.options.encryptionKey
		}

		this.out.debug('Encrypting with dynamic key')
		return new Promise((resolve, reject) => {
			this.out.debug('Waiting for decrypt event...')
			app.on('decrypt', encryptionKey => {
				this.out.info(`decrypt event called, attempting to decrypt`)
				if (encryptionKey) {
					resolve(encryptionKey)
				} else {
					reject(`Encryption key is invalid`)
				}
			})
		})
	}

	async $find(params?: P & {paginate?: PaginationOptions}): Promise<Paginated<T>>
	async $find(params?: P & {paginate: false}): Promise<T[]>
	async $find(params: P = {} as P): Promise<Paginated<T> | T[]> {
		await this.$ready()
		const {filters, query, paginate} = filterParams(params)
		this.out.debug('$find', {filters, query, paginate})

		let options: PouchDB.Find.FindRequest<any> = {selector: query}

		if (paginate) {
			options.limit = filters?.$limit || paginate.default
			if (options.limit > paginate.max) {
				options.limit = paginate.max
			}
		}

		if (filters.$skip) {
			options.skip = filters.$skip
		}

		const results: Paginated<T> = {
			total: 0,
			limit: filters.$limit,
			skip: filters.$skip || 0,
			data: []
		}

		try {
			const res = await this.client.find(options)
			results.data = this.filterDocs(res.docs)
		} catch (e) {
			const error = new PouchError('Failed to find documents', e)
			this.out.error(error)
			throw error
		}

		if (paginate === false) {
			return results.data
		}

		return results
	}

	async $ready() {
		if (!this.client) {
			const error = new PouchError('PouchDB client is not initialized! If you are overriding the setup() method, make sure to call super.setup()')
			this.out.error(error)
			throw error
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async $get(id: Id, _params: P = {} as P): Promise<ExistingDocument<T>> {
		await this.$ready()
		let doc: any
		try {
			doc = await this.client.get(String(id))
		} catch (e) {
			throw new NotFound(`No record found for id '${id}'`)
		}
		if (doc) {
			return doc as unknown as ExistingDocument<T>
		}
		throw new NotFound(`No record found for id '${id}'`)
	}

	async $put(data: PutDocument<Document>, params?: P): Promise<ExistingDocument<T>>
	async $put(data: PutDocument<Document>[], params?: P): Promise<ExistingDocument<T>[]>
	async $put(data: PutDocument<Document> | PutDocument<Document>[], _params?: P): Promise<ExistingDocument<T> | ExistingDocument<T>[]>
	async $put(data: PutDocument<Document> | PutDocument<Document>[], params: P = {} as P): Promise<ExistingDocument<T> | ExistingDocument<T>[]> {
		await this.$ready()
		if (Array.isArray(data) && this.allowsMulti('put')) {
			return Promise.all(data.map(current => this.$put(current, params)))
		}

		try {
			const result = await this.client.put(data as PutDocument<Document>)
			return this.$get(result.id, params)
		} catch (e) {
			const error = new PouchError('Failed to put document', e)
			this.out.error(error)
			throw error
		}
	}

	async $create(data: PostDocument<Document>, params?: P): Promise<ExistingDocument<T>>
	async $create(data: PostDocument<Document>[], params?: P): Promise<ExistingDocument<T>[]>
	async $create(data: PostDocument<Document> | PostDocument<Document>[], _params?: P): Promise<ExistingDocument<T> | ExistingDocument<T>[]>
	async $create(data: PostDocument<Document> | PostDocument<Document>[], params: P = {} as P): Promise<ExistingDocument<T> | ExistingDocument<T>[]> {
		await this.$ready()
		if (Array.isArray(data) && this.allowsMulti('create')) {
			return Promise.all(data.map(current => this.$create(current, params)))
		}

		try {
			const result = await this.client.post(data as PostDocument<Document>)
			return this.$get(result.id, params)
		} catch (e) {
			const error = new PouchError('Failed to create document', e)
			this.out.error(error)
			throw error
		}
	}

	async $update(id: Id, data: PutDocument<Document>, params: P = {} as P): Promise<ExistingDocument<T>> {
		await this.$ready()
		if (!id) {
			throw new NotFound('No id provided')
		}
		const current = await this.$get(id) as ExistingDocument<T>
		data._rev = current._rev
		await this.client.put(data)
		return this.$get(data._id, params)
	}

	async $patch(id: null, data: PutDocument<Document>, params?: P): Promise<ExistingDocument<T>[]>
	async $patch(id: Id, data: PutDocument<Document>, params?: P): Promise<ExistingDocument<T>>
	async $patch(id: NullableId, data: PutDocument<Document>, _params?: P): Promise<ExistingDocument<T>[] | T>
	async $patch(id: NullableId, data: PutDocument<Document>, params: P = {} as P): Promise<ExistingDocument<T>[] | T> {
		await this.$ready()
		if (this.isMulti(id, params)) {
			return this.$multi('$patch', params)
		}
		const old_data = this.$get(id, params)
		const new_data = merge(old_data, data) as PutDocument<Document>
		return this.$update(id, new_data, params)
	}

	async $remove(id: null, params?: P): Promise<ExistingDocument<T>[]>
	async $remove(id: Id, params?: P): Promise<T>
	async $remove(id: NullableId, _params?: P): Promise<ExistingDocument<T>[] | T>
	async $remove(id: NullableId, params: P = {} as P): Promise<ExistingDocument<T>[] | T> {
		await this.$ready()
		if (!id && this.allowsMulti('remove')) {
			return this.$multi('$remove', params)
		}

		const doc = await this.$get(id, params)
		await this.client.remove(doc)
		return doc
	}

	async $multi(method: string, params?: P): Promise<ExistingDocument<T>[]> {
		const items = await this.$find({
			...params,
			paginate: false
		}) as unknown as ExistingDocument<T>[]
		return Promise.all(items.map(item => this[method](item[this.id])))
	}
}

export default PouchAdapter
