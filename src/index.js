const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')
const uuidv4 = require('uuid/v4')
const pump = require('pump')

const dbExists = require('./indexedDBUtils').dbExists
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

/**
 * Return when hyperDb instance is ready
 * @param {Object} db - The hyperDb instance
 */
const dbReady = (db) => {
  return new Promise((resolve, reject) => {
    db.on('ready', () => {
      resolve()
    })
  })
}

class Masq {
  /**
   * constructor
   * @param {string} app - The application name
   */
  constructor (app) {
    this.profile = null
    this.sws = {}
    this.hubs = {}
    this.app = app
    this.channel = null
    this.challenge = null
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

  _initSwarmWithDataHandler (dataHandler) {
    // Subscribe to channel for a limited time to sync with masq
    debug(`Creation of a hub with ${this.channel} channel name`)
    const hub = signalhub(this.channel, [HUB_URL])
    let sw = null

    if (swarm.WEBRTC_SUPPORT) {
      sw = swarm(hub)
    } else {
      sw = swarm(hub, { wrtc: require('wrtc') })
    }

    sw.on('peer', (peer, id) => {
      debug(`The peer ${id} join us...`)
      peer.on('data', data => dataHandler(sw, peer, data))
    })

    sw.on('close', () => {
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      sw.close()
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
    const link = this._genGetProfilesLink()

    // TODO generate a QR code with the link

    const handleData = async (sw, peer, data) => {
      const json = JSON.parse(data)

      switch (json.msg) {
        case 'sendProfilesKey':
          // check challenges
          if (json.challenge !== this.challenge) {
            debug('challenge mismatches')
            // This peer may be malicious, close the connection
            sw.close()
          } else {
            // db creation
            debug(`Creation of hyperdb masq-profiles with the received key ${json.key.slice(0, 5)}`)
            const db = hyperdb(rai('masq-profiles'), Buffer.from(json.key, 'hex'), { valueEncoding: 'json' })
            await dbReady(db)

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

    this._initSwarmWithDataHandler(handleData)

    return {
      link: link,
      challenge: this.challenge,
      channel: this.channel
    }
  }

  /**
   * After the masq-profiles replication, the right profile is chosen,
   * the next steps are :
   * - getting the hyperdb key from masq
   * - request write authorization by sending the local key
   */
  exchangeDataHyperdbKeys () {
    if (!this.profile) throw (Error('No profile selected'))

    // generation of link with new channel and challenge for the exchange of keys
    const link = this._genGetAppDataLink()

    const handleData = async (sw, peer, data) => {
      const json = JSON.parse(data)

      switch (json.msg) {
        case 'sendDataKey':
          if (json.challenge !== this.challenge) {
            // This peer may be malicious, close the connection
            sw.close()
          } else {
            // db creation and replication
            debug(`Creation of data hyperdb ${this.profile}`)
            const db = hyperdb(rai(this.profile), Buffer.from(json.key, 'hex'), { valueEncoding: 'json' })
            await dbReady(db)
            // Store
            this.dbs[this.profile] = db

            peer.send(JSON.stringify({
              msg: 'requestWriteAccess',
              key: db.local.key.toString('hex')
            }))
          }
          break
        case 'ready':
          // Masq must send ready after the authorization
          this._startReplication(this.dbs[this.profile], this.profile)
          sw.close()
          break
        default:
          break
      }
    }
    this._initSwarmWithDataHandler(handleData)

    return {
      link: link,
      challenge: this.challenge,
      channel: this.channel
    }
  }

  _startReplication (db, name) {
    debug(`Start replication for ${name}`)
    const discoveryKey = db.discoveryKey.toString('hex')
    this.hubs[name] = signalhub(discoveryKey, [HUB_URL])
    const hub = this.hubs[name]

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
    if (!(await dbExists('masq-profiles'))) {
      return
    }
    const db = hyperdb(rai('masq-profiles'), { valueEncoding: 'json' })
    await dbReady(db)
    this.dbs.profiles = db
    this._startReplication(db, 'masq-profiles')
    let profiles = await this.getProfiles()

    for (let index = 0; index < profiles.length; index++) {
      let id = profiles[index].id
      if (!(await dbExists(id))) {
        continue
      }
      const db = hyperdb(rai(id), { valueEncoding: 'json' })
      await dbReady(db)
      this.dbs[id] = db
      this._startReplication(db, id)
    }
  }

  _genGetProfilesLink () {
    this.channel = uuidv4()
    this.challenge = uuidv4()
    const myUrl = new URL(MASQ_APP_BASE_URL)
    myUrl.searchParams.set('requestType', 'syncProfiles')
    myUrl.searchParams.set('channel', this.channel)
    myUrl.searchParams.set('challenge', this.challenge)
    return myUrl.href
  }
  _genGetAppDataLink () {
    this.channel = uuidv4()
    this.challenge = uuidv4()
    const myUrl = new URL(MASQ_APP_BASE_URL)
    myUrl.searchParams.set('requestType', 'syncAppData')
    myUrl.searchParams.set('channel', this.channel)
    myUrl.searchParams.set('challenge', this.challenge)
    myUrl.searchParams.set('appName', this.app)
    myUrl.searchParams.set('profileID', this.profileID)
    return myUrl.href
  }
}

module.exports = Masq
