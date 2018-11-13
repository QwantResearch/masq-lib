const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')
const uuidv4 = require('uuid/v4')
const pump = require('pump')

const HUB_URL = 'localhost:8080'

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
    this._generateLinkParameters()
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
  getProfiles () {
    return new Promise((resolve, reject) => {
      this.dbs.profiles.get('/profiles', (err, nodes) => {
        if (err) return reject(err)
        if (!nodes.length) return resolve([])

        const ids = nodes[0].value

        let promiseArr = []
        for (let id of ids) {
          promiseArr.push(this.getProfileByID(id))
        }
        return resolve(Promise.all(promiseArr))
      })
    })
  }

  getProfileByID (id) {
    return new Promise((resolve, reject) => {
      this.dbs.profiles.get(`/profiles/${id}`, (err, nodes) => {
        if (err) return reject(err)
        if (!nodes || !nodes[0] || !nodes[0].value) return reject(Error('Errooooor : ' + id + ' ; ' + JSON.stringify(nodes)))
        return resolve(nodes[0].value)
      })
    })
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
  get (key) {
    try {
      let db = this._getDB()
      return new Promise((resolve, reject) => {
        db.get(key, (err, nodes) => {
          if (err) return reject(err)
          if (!nodes.length) return resolve(nodes[0])
          resolve(nodes[0].value)
        })
      })
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /**
   * Put a new value in the current profile database
   * @param {string} key - Key
   * @param {string} value - The value to insert
   * @returns {Promise}
   */
  put (key, value) {
    try {
      let db = this._getDB()
      return new Promise((resolve, reject) => {
        db.put(key, value, err => {
          if (err) return reject(err)
          resolve()
        })
      })
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /**
   * Delete a key
   * @param {string} key - Key
   * @returns {Promise}
   */
  del (key) {
    try {
      let db = this._getDB()
      return new Promise((resolve, reject) => {
        db.del(key, (err) => {
          if (err) return reject(err)
          resolve()
        })
      })
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /**
   * If this is the first time, this.dbs.profiles is empty.
   * We need to get masq-profiles hyperdb key of masq.
   */
  requestMasqAccess () {
    // Subscribe to channel for a limited time to sync with masq
    const hub = signalhub(this.channel, [HUB_URL])
    let sw = null

    if (swarm.WEBRTC_SUPPORT) {
      sw = swarm(hub)
    } else {
      sw = swarm(hub, { wrtc: require('wrtc') })
    }

    sw.on('peer', (peer, id) => {
      peer.on('data', data => _handleData(data, peer))
    })

    sw.on('close', () => {
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      sw.close()
    })

    const _handleData = async (data, peer) => {
      const json = JSON.parse(data)

      switch (json.msg) {
        case 'sendProfilesKey':
          // check challenges
          if (json.challenge !== this.challenge) {
            // This peer may be malicious, close the connection
            sw.close()
          } else {
            // db creation
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
  }

  /**
   * After the masq-profiles replication, the right profile is chosen,
   * the next steps are :
   * - getting the hyperdb key from masq
   * - request write authorization by sending the local key
   */
  exchangeDataHyperdbKeys () {
    // Subscribe to channel for a limited time to sync with masq
    if (!this.profile) throw (Error('No profile selected'))
    const hub = signalhub(this.channel, [HUB_URL])
    let sw = null

    if (swarm.WEBRTC_SUPPORT) {
      sw = swarm(hub)
    } else {
      sw = swarm(hub, { wrtc: require('wrtc') })
    }

    sw.on('peer', (peer, id) => {
      // check challenges
      peer.on('data', data => _handleData(data, peer))
    })

    sw.on('close', () => {
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      sw.close()
    })

    const _handleData = async (data, peer) => {
      const json = JSON.parse(data)

      switch (json.msg) {
        case 'sendDataKey':
          if (json.challenge !== this.challenge) {
            // This peer may be malicious, close the connection
            sw.close()
          } else {
            // db creation and replication
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
  }

  _startReplication (db, name) {
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
  _openAndSyncDatabases () {
    // const db = hyperdb(rai('masq-profiles'), { valueEncoding: 'json' })
    // this.dbs.profiles = db
  }

  _generateLinkParameters () {
    this.channel = uuidv4()
    this.challenge = uuidv4()
  }

  _getLink () {
    return `?channel=${this.channel}&challenge=${this.challenge}`
  }
}

module.exports = Masq
