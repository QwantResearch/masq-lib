const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const uuidv4 = require('uuid/v4')
const pump = require('pump')

const utils = require('./utils')
const config = require('../config/config')

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
  constructor (appName, appDescription, appImageURL) {
    this.userAppDb = null
    this.userAppRepSW = null
    this.userAppRepHub = null

    this.appName = appName
    this.appDescription = appDescription
    this.appImageURL = appImageURL
  }

  destroy () {
    return new Promise((resolve) => {
      if (!this.userAppRepSW) {
        resolve()
      }
      this.userAppRepSW.close(resolve)
    })
  }

  _getDB () {
    if (!this.userAppDb) throw Error('Not connected to Masq')
    return this.userAppDb
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
    const nodes = await db.getAsync(key)
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
    return db.putAsync(key, value)
  }

  /**
   * Delete a key
   * @param {string} key - Key
   * @returns {Promise}
   */
  async del (key) {
    let db = this._getDB()
    return db.delAsync(key)
  }

  async _initSwarmWithDataHandler (channel, dataHandler) {
    return new Promise((resolve, reject) => {
      // Subscribe to channel for a limited time to sync with masq
      debug(`Creation of a hub with ${channel} channel name`)
      const hub = signalhub(channel, config.HUB_URLS)
      let sw = null

      if (swarm.WEBRTC_SUPPORT) {
        sw = swarm(hub)
      } else {
        sw = swarm(hub, { wrtc: require('wrtc') })
      }

      sw.on('peer', (peer, id) => {
        debug(`The peer ${id} join us...`)
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

  async _genGetProfilesLink () {
    const channel = uuidv4()
    const key = await window.crypto.subtle.generateKey(
      {
        name: 'AES-GCM',
        length: 128
      },
      true, // whether the key is extractable (i.e. can be used in exportKey)
      ['encrypt', 'decrypt'] // can 'encrypt', 'decrypt', 'wrapKey', or 'unwrapKey'
    )
    const extractedKey = await window.crypto.subtle.exportKey('raw', key)
    const keyBase64 = extractedKey.toString('base64')
    const myUrl = new URL(config.MASQ_APP_BASE_URL)
    myUrl.searchParams.set('requestType', 'login')
    myUrl.searchParams.set('channel', channel)
    myUrl.searchParams.set('key', keyBase64)

    return {
      link: myUrl.href,
      channel,
      key
    }
  }

  _startReplication (db) {
    const discoveryKey = db.discoveryKey.toString('hex')
    this.userAppRepHub = signalhub(discoveryKey, config.HUB_URLS)

    if (swarm.WEBRTC_SUPPORT) {
      this.userAppRepSW = swarm(this.userAppRepHub)
    } else {
      this.userAppRepSW = swarm(this.userAppRepHub, { wrtc: require('wrtc') })
    }

    this.userAppRepSW.on('peer', async (peer, id) => {
      const stream = db.replicate({ live: true })
      pump(peer, stream, peer)
    })
  }

  /**
   * If this is the first time, this.dbs.profiles is empty.
   * We need to get masq-profiles hyperdb key of masq.
   * @returns {string, string, string}
   *  link - the link to open the masq app with the right
   *  key
   *  channel
   */
  async connectToMasq () {
    // generation of link with new channel and key for the sync of new peer
    const { link, channel, key } = await this._genGetProfilesLink()
    let registering = false
    let waitingForWriteAccess = false

    const handleData = async (sw, peer, data) => {
      // decrypt the received message and check if the right key has been used
      const json = await utils.decryptMessage(key, data)

      switch (json.msg) {
        case 'authorized':
          if (!json.id) {
            this._connectToMasqErr = Error('Database Id not found in \'authorized\' message')
            sw.close()
            return
          }

          const dbId = json.id
          if (utils.dbExists(dbId)) {
            const db = utils.createPromisifiedHyperDB(dbId)
            await utils.dbReady(db)
            this.userAppDb = db

            debug(`Start replication for db with id ${json.id}`)
            this._startReplication(db)
            return
            // done with the connection to Masq
          }
          registering = true
          peer.send(await utils.encryptMessage(key, {
            msg: 'registerUserApp',
            name: this.appName,
            description: this.appDescription,
            imageURL: this.appImageURL
          }))

          break

        case 'notAuthorized':
          registering = true
          peer.send(await utils.encryptMessage(key, {
            msg: 'registerUserApp',
            name: this.appName,
            description: this.appDescription,
            imageURL: this.appImageURL
          }))
          break

        case 'masqAccessGranted':
          if (!registering) {
            this._connectToMasqErr = Error('Unexpectedly received dbKey while not registering')
            sw.close()
            return
          }
          registering = false

          if (!json.key) {
            this._connectToMasqErr = Error('Database key not found in \'dbKey\' message')
            sw.close()
            return
          }

          if (!json.id) {
            this._connectToMasqErr = Error('Database id not found in \'dbKey\' message')
            sw.close()
            return
          }

          const db = utils.createPromisifiedHyperDB(json.id, json.key)
          await utils.dbReady(db)
          this.userAppDb = db

          this._startReplication(db)

          waitingForWriteAccess = true
          peer.send(await utils.encryptMessage(key, {
            msg: 'requestWriteAccess',
            key: db.local.key.toString('hex')
          }))
          break

        case 'masqAccessRefused':
          if (!registering) {
            this._connectToMasqErr = Error('Unexpectedly received dbKey while not registering')
            sw.close()
            return
          }
          this._connectToMasqErr = Error('Masq access refused by the user')
          sw.close()
          return

        case 'writeAccessGranted':
          if (!waitingForWriteAccess) {
            this._connectToMasqErr = Error('Unexpectedly received writeAccessGranted while not registering')
            sw.close()
            return
          }
          waitingForWriteAccess = false

          sw.close()
          break

        default:
          break
      }
    }

    this._initSwarmWithDataHandler(channel, handleData).then(
      () => {
        this._connectToMasqDone = true
        if (this._onConnectToMasqDone) this._onConnectToMasqDone()
      }
    )

    return {
      channel,
      link
    }
  }

  connectToMasqDone () {
    return new Promise((resolve, reject) => {
      if (this._connectToMasqDone) {
        this._connectToMasqDone = false
        if (this._connectToMasqErr) {
          return reject(this._connectToMasqErr)
        } else {
          return resolve()
        }
      }
      this._onConnectToMasqDone = () => {
        this._onConnectToMasqDone = undefined
        this._connectToMasqDone = false
        if (this._connectToMasqErr) {
          return reject(this._connectToMasqErr)
        } else {
          return resolve()
        }
      }
    })
  }
}

module.exports = Masq
