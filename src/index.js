const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const uuidv4 = require('uuid/v4')
const pump = require('pump')
const common = require('masq-common')
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
    this._reset()

    this.appName = appName
    this.appDescription = appDescription
    this.appImageURL = appImageURL

    this.userId = null
    this.userAppDb = null

    this._loadSessionInfo()
  }

  _reset () {
    this.userAppRepSW = null
    this.userAppRepHub = null

    this._logIntoMasqErr = null
    this._logIntoMasqDone = false
  }

  isLoggedIn () {
    // is logged in if the userAppDbId is known
    // (either after register or after construction and load session info)
    return !!this.userId
  }

  isConnected () {
    // is connected if the userAppDb has been created and initialized
    return !!this.userAppDb
  }

  async connectToMasq () {
    if (!this.isLoggedIn()) {
      await this.disconnect()
      throw Error('Not logged into Masq')
    }

    const db = common.utils.createPromisifiedHyperDB(this.userId)
    this.userAppDb = db
    await common.utils.dbReady(db)
    this._startReplication()
  }

  disconnect () {
    return new Promise((resolve) => {
      this.userAppDb = null
      if (!this.userAppRepSW) {
        this._reset()
        resolve()
        return
      }
      this.userAppRepSW.close(() => {
        this._reset()
        resolve()
      })
    })
  }

  async signout () {
    this.userId = null
    this.userAppDb = null

    await this.disconnect()
    this._deleteSessionInfo()
  }

  _deleteSessionInfo () {
    window.localStorage.removeItem('userId')
    window.sessionStorage.removeItem('userId')
  }

  _storeSessionInfo (stayConnected, userId) {
    if (stayConnected) {
      window.localStorage.setItem('userId', userId)
    }
    window.sessionStorage.setItem('userId', userId)
  }

  _loadSessionInfo () {
    // If userId is in sesssion storage, use it and do not touch localStorage
    const sessionUserId = window.sessionStorage.getItem('userId')
    if (sessionUserId) {
      this.userId = sessionUserId
      return
    }

    // if userId is is not in session storage, look for it in local storage
    // and save in session storage
    const localStorageUserId = window.localStorage.getItem('userId')
    if (localStorageUserId) {
      this.userId = localStorageUserId
      window.sessionStorage.setItem('userId', this.userId)
    }
  }

  async _initSwarmWithDataHandler (channel, dataHandler) {
    return new Promise((resolve, reject) => {
      // Subscribe to channel for a limited time to sync with masq
      debug(`Creation of a hub with ${channel} channel name`)
      const hub = signalhub(channel, config.HUB_URLS)
      const swOpts = swarm.WEBRTC_SUPPORT ? undefined : { wrtc: require('wrtc') }
      const sw = swarm(hub, swOpts)

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

  async _genConnectionMaterial () {
    const channel = uuidv4()
    const key = await common.crypto.genAESKey(true, 'AES-GCM', 128)
    const extractedKey = await common.crypto.exportKey(key)
    const keyBase64 = Buffer.from(extractedKey).toString('base64')
    const myUrl = new URL(config.MASQ_APP_BASE_URL)
    const requestType = 'login'
    const hashParams = JSON.stringify([this.appName, requestType, channel, keyBase64])
    myUrl.hash = '/' + Buffer.from(hashParams).toString('base64')

    return {
      link: myUrl.href,
      channel,
      key
    }
  }

  _startReplication () {
    const discoveryKey = this.userAppDb.discoveryKey.toString('hex')
    this.userAppRepHub = signalhub(discoveryKey, config.HUB_URLS)

    if (swarm.WEBRTC_SUPPORT) {
      this.userAppRepSW = swarm(this.userAppRepHub)
    } else {
      this.userAppRepSW = swarm(this.userAppRepHub, { wrtc: require('wrtc') })
    }

    this.userAppRepSW.on('peer', async (peer, id) => {
      const stream = this.userAppDb.replicate({ live: true })
      pump(peer, stream, peer)
    })
  }

  async _isRegistered (userId) {
    // is registered if there is a db for this userId
    return common.utils.dbExists(userId)
  }

  async _requestUserAppRegister (key, peer) {
    const msg = {
      msg: 'registerUserApp',
      name: this.appName,
      description: this.appDescription,
      imageURL: this.appImageURL
    }
    let encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
    peer.send(JSON.stringify(encryptedMsg))
  }

  async _requestWriteAccess (encryptionKey, peer, localDbKey) {
    const msg = {
      msg: 'requestWriteAccess',
      key: localDbKey.toString('hex')
    }
    const encryptedMsg = await common.crypto.encrypt(encryptionKey, msg, 'base64')
    peer.send(JSON.stringify(encryptedMsg))
  }

  async _sendConnectionEstablished (key, peer) {
    const msg = {
      msg: 'connectionEstablished'
    }
    const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')

    peer.send(JSON.stringify(encryptedMsg))
  }

  // All error handling for received messages
  _checkMessage (json, registering, waitingForWriteAccess, errorHandler) {
    let err = false
    const handleError = () => {
      errorHandler()
      err = true
    }
    switch (json.msg) {
      case 'authorized':
        if (!json.userAppDbId) {
          handleError('User Id not found in \'authorized\' message')
        }
        break

      case 'notAuthorized':
        break

      case 'masqAccessGranted':
        if (!registering) {
          handleError('Unexpectedly received "masqAccessGranted" message while not registering')
          break
        }

        if (!json.key) {
          handleError('Database key not found in "masqAccessGranted" message')
          break
        }

        if (!json.userAppDbId) {
          handleError('User Id not found in "masqAccessGranted" message')
        }
        break

      case 'masqAccessRefused':
        if (!registering) {
          handleError('Unexpectedly received "masqAccessRefused" while not registering')
        }
        break

      case 'writeAccessGranted':
        if (!waitingForWriteAccess) {
          handleError('Unexpectedly received "writeAccessGranted" while not waiting for write access')
        }
        break

      default:
        handleError(`Unexpectedly received message with type ${json.msg}`)
        break
    }

    return err
  }

  /**
   * If this is the first time, this.dbs.profiles is empty.
   * We need to get masq-profiles hyperdb key of masq.
   * @returns {string, string, string}
   *  link - the link to open the masq app with the right
   */
  async logIntoMasq (stayConnected) {
    // logout if loggedin when called
    if (this.userId) {
      this.signout()
    }

    // generation of link with new channel and key for the sync of new peer
    const { link, channel, key } = await this._genConnectionMaterial()
    let registering = false
    let waitingForWriteAccess = false

    let userId
    let db

    const handleData = async (sw, peer, data) => {
      const handleError = (msg) => {
        this._logIntoMasqErr = Error(msg)
        sw.close()
      }

      // decrypt the received message and check if the right key has been used
      let json
      try {
        json = await common.crypto.decrypt(key, JSON.parse(data), 'base64')
      } catch (err) {
        if (err.message === 'Unsupported state or unable to authenticate data') {
          handleError('Unable to read the message with the key sent to Masq-app')
          return
        }
        handleError('Unknown error while decrypting: ' + err.message)
        return
      }

      this._checkMessage(json, registering, waitingForWriteAccess, handleError)

      switch (json.msg) {
        case 'authorized':
          userId = json.userAppDbId

          // Check if the User-app is already registered
          if (await this._isRegistered(userId)) {
            this.userId = userId
            // Store the session info
            this._storeSessionInfo(stayConnected, userId)

            await this.connectToMasq()
            // logged into Masq
            await this._sendConnectionEstablished(key, peer)
            sw.close()
            return
          }

          // if this UserApp instance is not registered
          registering = true
          this._requestUserAppRegister(key, peer)
          break

        case 'notAuthorized':
          // if this User-app is not registered
          registering = true
          this._requestUserAppRegister(key, peer)
          break

        case 'masqAccessGranted':
          registering = false

          const buffKey = Buffer.from(json.key, 'hex')
          db = common.utils.createPromisifiedHyperDB(userId, buffKey)
          await common.utils.dbReady(db)

          waitingForWriteAccess = true
          this._requestWriteAccess(key, peer, db.local.key)
          break

        case 'masqAccessRefused':
          registering = false
          handleError('Masq access refused by the user')
          return

        case 'writeAccessGranted':
          waitingForWriteAccess = false

          // Store the session info
          this._storeSessionInfo(stayConnected, userId)
          this.userId = userId
          this.userAppDb = db
          this._startReplication()

          sw.close()
          break
      }
    }

    this._initSwarmWithDataHandler(channel, handleData).then(
      () => {
        this._logIntoMasqDone = true
        if (this._onLogIntoMasqDone) this._onLogIntoMasqDone()
      }
    )

    return {
      link
    }
  }

  logIntoMasqDone () {
    return new Promise((resolve, reject) => {
      if (this._logIntoMasqDone) {
        this._logIntoMasqDone = false
        if (this._logIntoMasqErr) {
          return reject(this._logIntoMasqErr)
        } else {
          return resolve()
        }
      }
      this._onLogIntoMasqDone = () => {
        this._onLogIntoMasqDone = undefined
        this._logIntoMasqDone = false
        if (this._logIntoMasqErr) {
          return reject(this._logIntoMasqErr)
        } else {
          return resolve()
        }
      }
    })
  }

  //
  // Database Access Functions
  //

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
    const db = this._getDB()
    return db.watch(key, () => cb())
  }

  /**
   * Get a value
   * @param {string} key - Key
   * @returns {Promise}
   */
  async get (key) {
    const db = this._getDB()
    const node = await db.getAsync(key)
    if (!node) return null
    return node.value
  }

  /**
   * Put a new value in the current profile database
   * @param {string} key - Key
   * @param {string} value - The value to insert
   * @returns {Promise}
   */
  async put (key, value) {
    const db = this._getDB()
    return db.putAsync(key, value)
  }

  /**
   * Delete a key
   * @param {string} key - Key
   * @returns {Promise}
   */
  async del (key) {
    const db = this._getDB()
    return db.delAsync(key)
  }

  /**
   * List all keys and values
   * @param {string} prefix - Prefix
   * @returns {Promise}
   */
  async list (prefix) {
    const db = this._getDB()
    const list = await db.listAsync(prefix)
    const reformattedDic = list.reduce((dic, e) => {
      const el = Array.isArray(e) ? e[0] : e
      dic[el.key] = el.value
      return dic
    }, {})
    return reformattedDic
  }
}

module.exports = Masq
