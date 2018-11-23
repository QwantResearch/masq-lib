const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')
const uuidv4 = require('uuid/v4')
const pump = require('pump')

const promiseHyperdb = require('./promiseHyperdb')

const HUB_URL = 'localhost:8080'
const MASQ_APP_BASE_URL = 'http://localhost:3000'

const debug = (function () {
  switch (process.env.NODE_ENV) {
    case ('development'):
      return console.log
    default:
      return () => {}
  }
})()

class Masq {
  /**
   * constructor
   * @param {string} appName - The application name
   */
  constructor (appName) {
    this.profile = null
    this.sws = {}
    this.hubs = {}
    this.appName = appName
    this.dbs = {
      profiles: null // masq public profiles
    }
  }

  /**
   * @returns {Promise}
   */
  init () {
    return this._openAndSyncDatabases()
  }

  destroy () {
    const prArr = Object.values(this.sws).map(sw => {
      return new Promise((resolve, reject) => {
        sw.close(resolve)
      })
    })
    return Promise.all(prArr)
  }

  /**
   * Get all profiles registered in masq
   * @returns {Promise}
   */
  async getProfiles () {
    const nodes = await promiseHyperdb.get(this.dbs.profiles, '/profiles')
    if (!nodes.length) return []
    const ids = nodes[0].value
    debug(`profiles ids, ${JSON.stringify(ids)}`)

    let promiseArr = []
    for (let id of ids) {
      promiseArr.push(this.getProfileByID(id))
    }
    return Promise.all(promiseArr)
  }

  async getProfileByID (id) {
    const nodes = await promiseHyperdb.get(this.dbs.profiles, `/profiles/${id}`)
    if (!nodes || !nodes[0] || !nodes[0].value) return nodes
    return nodes[0].value
  }

  /**
   * Set the current profile
   * @param {string} id - The profile id
   */
  setProfile (id) {
    // check id
    this.profile = id
  }

  _getDB () {
    if (!this.profile) throw Error('No profile selected')
    let db = this.dbs[this.profile]
    if (!db) throw Error('db does not exist for selected profile')
    return db
  }

  /**
   * Set a watcher
   * @param {string} key - Key
   * @returns {Object}
   */
  watch (key, cb) {
    let db = this._getDB()
    return db.watch(key, () => cb())
  }

  /**
   * Get a value
   * @param {string} key - Key
   * @returns {Promise}
   */
  async get (key) {
    let db = this._getDB()
    const nodes = await promiseHyperdb.get(db, key)
    if (!nodes.length) return nodes[0]
    return nodes[0].value
  }

  /**
   * Put a new value in the current profile database
   * @param {string} key - Key
   * @param {string} value - The value to insert
   * @returns {Promise}
   */
  async put (key, value) {
    let db = this._getDB()
    return promiseHyperdb.put(db, key, value)
  }

  /**
   * Delete a key
   * @param {string} key - Key
   * @returns {Promise}
   */
  async del (key) {
    let db = this._getDB()
    return promiseHyperdb.put(db, key)
  }

  async _initSwarmWithDataHandler (channel, dataHandler, initialMessage) {
    return new Promise((resolve, reject) => {
      // Subscribe to channel for a limited time to sync with masq
      debug(`Creation of a hub with ${channel} channel name`)
      const hub = signalhub(channel, [HUB_URL])
      let sw = null

      if (swarm.WEBRTC_SUPPORT) {
        sw = swarm(hub)
      } else {
        sw = swarm(hub, { wrtc: require('wrtc') })
      }

      sw.on('peer', (peer, id) => {
        debug(`The peer ${id} join us...`)
        if (initialMessage) { peer.send(initialMessage) }
        peer.on('data', (data) => { dataHandler(sw, peer, data) })
      })

      sw.on('disconnect', (peer, id) => {
        sw.close()
      })

      sw.on('close', () => {
        resolve()
      })
    })
  }

  /**
   * If this is the first time, this.dbs.profiles is empty.
   * We need to get masq-profiles hyperdb key of masq.
   * @returns {string, string, string}
   *  link - the link to open the masq app with the right
   *  challenge
   *  channel
   */
  requestMasqAccess () {
    // generation of link with new channel and challenge for the sync of new peer
    const { link, channel, challenge } = this._genGetProfilesLink()

    // TODO generate a QR code with the link

    const handleData = async (sw, peer, data) => {
      const json = JSON.parse(data)

      switch (json.msg) {
        case 'sendProfilesKey':
          // check challenges
          if (json.challenge !== challenge) {
            // This peer may be malicious, close the connection
            sw.close()
          } else {
            // db creation
            debug(`Creation of hyperdb masq-profiles with the received key ${json.key.slice(0, 5)}`)
            const db = hyperdb(rai('masq-profiles'), Buffer.from(json.key, 'hex'), { valueEncoding: 'json' })
            await promiseHyperdb.ready(db)

            // Store
            this.dbs.profiles = db

            peer.send(JSON.stringify({
              msg: 'replicationProfilesStarted'
            }))
            // db replication
            this._startReplication(this.dbs.profiles, 'profiles')
            sw.close()
          }
          break
        default:
          break
      }
    }

    this._initSwarmWithDataHandler(channel, handleData).then(() => {
      this._requestMasqAccessDone = true
      if (this._onRequestMasqAccessDone) this._onRequestMasqAccessDone()
    })

    return {
      channel,
      challenge,
      link
    }
  }

  requestMasqAccessDone () {
    return new Promise((resolve, reject) => {
      if (this._requestMasqAccessDone) return resolve()
      this._onRequestMasqAccessDone = resolve
    })
  }

  /**
   * After the masq-profiles replication, the right profile is chosen,
   * the next steps are :
   * - sending the appInfo
   * - getting the hyperdb key from masq
   * - request write authorization by sending the local key
   * @param {Object} appInfo - The application info : name, description and image
   */
  exchangeDataHyperdbKeys (appInfo) {
    this._exchangeDataDone = false
    if (!this.profile) {
      this._exchangeDataDone = true
      throw (Error('No profile selected'))
    }

    // generation of link with new channel and challenge for the exchange of keys
    const { link, channel, challenge } = this._genGetAppDataLink()

    const appInfoMessage = JSON.stringify({
      ...appInfo, msg: 'appInfo'
    })

    const handleData = async (sw, peer, data) => {
      const json = JSON.parse(data)

      switch (json.msg) {
        case 'sendDataKey':
          if (json.challenge !== challenge) {
            // This peer may be malicious, close the connection
            sw.close()
            break
          }

          // db creation and replication
          const db = hyperdb(rai(this.profile), Buffer.from(json.key, 'hex'), { valueEncoding: 'json' })
          await promiseHyperdb.ready(db)
          // Store
          this.dbs[this.profile] = db

          peer.send(JSON.stringify({
            msg: 'requestWriteAccess',
            key: db.local.key.toString('hex')
          }))
          break

        case 'ready':
          if (json.challenge !== challenge) {
            // This peer may be malicious, close the connection
            sw.close()
            break
          }
          // Masq must send ready after the authorization
          this._startReplication(this.dbs[this.profile], this.profile)
          sw.close()
          break
        default:
          break
      }
    }
    this._initSwarmWithDataHandler(channel, handleData, appInfoMessage).then(() => {
      this._exchangeDataDone = true
      if (this._onExchangeDone) this._onExchangeDone()
    })

    return {
      channel,
      challenge,
      link
    }
  }

  exchangeDataHyperdbKeysDone () {
    return new Promise((resolve, reject) => {
      if (this._exchangeDataDone) return resolve()
      this._onExchangeDone = resolve
    })
  }

  _startReplication (db, name) {
    debug(`Start replication for ${name}`)
    const discoveryKey = db.discoveryKey.toString('hex')
    const hub = signalhub(discoveryKey, [HUB_URL])
    this.hubs[name] = hub

    if (swarm.WEBRTC_SUPPORT) {
      this.sws[name] = swarm(hub)
    } else {
      this.sws[name] = swarm(hub, { wrtc: require('wrtc') })
    }
    const sw = this.sws[name]

    sw.on('peer', async (peer, id) => {
      const stream = db.replicate({ live: true })
      pump(peer, stream, peer)
    })
  }

  /** open and sync existing databases */
  _openAndSyncDatabase () {
  }

  /** open and sync existing databases */
  async _openAndSyncDatabases () {
    if (!(await promiseHyperdb.dbExists('masq-profiles'))) {
      return
    }
    const db = hyperdb(rai('masq-profiles'), { valueEncoding: 'json' })
    await promiseHyperdb.ready(db)
    this.dbs.profiles = db
    this._startReplication(db, 'masq-profiles')
    let profiles = await this.getProfiles()

    for (let index = 0; index < profiles.length; index++) {
      let id = profiles[index].id
      if (!(await promiseHyperdb.dbExists(id))) {
        continue
      }
      const db = hyperdb(rai(id), { valueEncoding: 'json' })
      await promiseHyperdb.ready(db)
      this.dbs[id] = db
      this._startReplication(db, id)
    }
  }

  _genGetProfilesLink () {
    const channel = uuidv4()
    const challenge = uuidv4()
    const myUrl = new URL(MASQ_APP_BASE_URL)
    myUrl.searchParams.set('requestType', 'syncProfiles')
    myUrl.searchParams.set('channel', channel)
    myUrl.searchParams.set('challenge', challenge)
    return {
      link: myUrl.href,
      channel,
      challenge
    }
  }
  _genGetAppDataLink () {
    const channel = uuidv4()
    const challenge = uuidv4()
    const myUrl = new URL(MASQ_APP_BASE_URL)
    myUrl.searchParams.set('requestType', 'syncAppData')
    myUrl.searchParams.set('channel', channel)
    myUrl.searchParams.set('challenge', challenge)
    myUrl.searchParams.set('appName', this.appName)
    myUrl.searchParams.set('profileID', this.profileID)
    return {
      link: myUrl.href,
      channel,
      challenge
    }
  }
}

module.exports = Masq
