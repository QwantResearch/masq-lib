const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const uuidv4 = require('uuid/v4')
const pump = require('pump')

const common = require('masq-common')
const MasqError = common.errors.MasqError
const CURRENT_USER_INFO_STR = 'currentUserInfo'

const jsonConfig = require('../config/config.prod.json')

const debug = (function () {
  switch (process.env.NODE_ENV) {
    case ('development'):
      return console.log
    default:
      return () => { }
  }
})()

class Masq {
  constructor (appName, appDescription, appImageURL, options = {}) {
    this.eventTarget = document.createElement('MasqLib')

    this.appName = appName
    this.appDescription = appDescription
    this.appImageURL = appImageURL

    // override config with constructor options
    this.config = {
      hubUrls: options.hubUrls ? options.hubUrls : jsonConfig.hubUrls,
      masqAppBaseUrl: options.masqAppBaseUrl ? options.masqAppBaseUrl : jsonConfig.masqAppBaseUrl,
      swarmConfig: options.swarmConfig ? options.swarmConfig : jsonConfig.swarmConfig
    }

    // init state
    this.state = 'notLogged'

    // login state data
    this.stayConnected = false
    this.loginChannel = null
    this.loginKey = null
    this.loginSw = null
    this.loginPeer = null

    // reset replication variables
    this.replicating = false
    this.userAppRepSW = null
    this.userAppRepHub = null

    // setup listeners
    this._listenForLoginOrSignout()
    this._listenForFocus()

    // init state through async function
    // this.init should be awaited to make sure state is initialized
    this.initPromise = this._init()
  }

  async setState (newState) {
    const currState = this.state

    // BEFORE
    switch (newState) {
      case 'notLogged':
        break
      case 'userAppDbCreated':
        break
      case 'accessMaterialReceived':
        break
      case 'registerNeeded':
        break
      case 'authorized':
        break
      case 'loggingIn':
        break
      case 'logged':
        if (currState !== 'notLogged' &&
            currState !== 'authorized' &&
            currState !== 'userAppDbCreated') {
          throw new MasqError(
            MasqError.INVALID_STATE_TRANSITION,
            'state transition invalid: ' + currState + ' -> ' + newState)
        }
        this._storeSessionInfo()
        break
      default:
        throw new MasqError()
    }

    // TRANSITION
    debug('[masq.setState] changing state : ' + currState + ' -> ' + newState)
    this.state = newState

    // AFTER
    switch (newState) {
      case 'notLogged':
        break
      case 'userAppDbCreated':
        break
      case 'accessMaterialReceived':
        break
      case 'registerNeeded':
        break
      case 'authorized':
        break
      case 'loggingIn':
        break
      case 'logged':
        debug('[masq.setState] dispatched event: logged_in')
        this.eventTarget.dispatchEvent(new Event('logged_in'))

        // TODO make sure try/catch is not needed
        try {
          this.startReplication()
        } catch (e) {
          console.error('startRep error : ' + e)
        }
        break
      default:
        throw new MasqError()
    }
  }

  async init () {
    await this.initPromise
  }

  async _init () {
    debug('[masq._init]')
    // try to login from session info
    await this._loadSessionInfo()

    // get login channel and key created at login link generation
    // sets this.loginKey and this.loginChannel
    // TODO check login link lifecycle
    await this._genLoginLink()
  }

  _listenForLoginOrSignout () {
    window.addEventListener('storage', async (e) => {
      if (e.key === CURRENT_USER_INFO_STR) {
        if (e.newValue === null) {
          if (this.isLoggedIn()) {
            debug('[masq._listenForLoginOrSignout] detected signout from another window/tab')
            await this.signout()
          }
        } else if (e.newValue) {
          // if we are logging in in the current tab
          if (this.state !== 'authorized' &&
              this.state !== 'accessMaterialReceived' &&
              this.state !== 'logged') {
            await this._loadSessionInfo()
            debug('[masq._listenForLoginOrSignout] detected login from another window/tab')
            debug('[masq._listenForLoginOrSignout] dispatch logged_in')
            this.eventTarget.dispatchEvent(new Event('logged_in'))
          }
        }
      }
    })
  }

  _listenForFocus () {
    document.addEventListener('focus', async () => {
      // try to reopen db
      if (!this.isLoggedIn()) {
        return
      }
      debug('[masq._listenForFocus] detected refocus on window')
      await this._openDb()
      try {
        this.startReplication()
      } catch (e) {
        console.log('replication after refocus failed')
      }
    })
  }

  async _loadSessionInfo () {
    debug('[masq._loadSessionInfo]')
    const auxLoginFromUserInfo = async (currentUserInfo) => {
      const { userAppDbId, userAppDEK, userAppNonce, username, profileImage } = JSON.parse(currentUserInfo)
      this.userAppDbId = userAppDbId
      this.userAppDEK = userAppDEK
      this.importedUserAppDEK = await common.crypto.importKey(Buffer.from(userAppDEK, 'hex'))
      this.userAppNonce = userAppNonce
      this.username = username
      this.profileImage = profileImage
      await this._openDb()
      await this.setState('logged')
    }

    // If user info is stored in session storage, do not use localStorage
    const currentUserInfo = window.sessionStorage.getItem(CURRENT_USER_INFO_STR)
    if (currentUserInfo) {
      await auxLoginFromUserInfo(currentUserInfo)
      return
    }

    // if userId is is not in session storage, look for it in local storage
    // and save in session storage
    const localStorageCurrentUserInfo = window.localStorage.getItem(CURRENT_USER_INFO_STR)
    if (localStorageCurrentUserInfo) {
      await auxLoginFromUserInfo(localStorageCurrentUserInfo)
      window.sessionStorage.setItem(CURRENT_USER_INFO_STR, localStorageCurrentUserInfo)
    }
  }

  async _openDb () {
    try {
      this.userAppDb = common.utils.createPromisifiedHyperDB(this.userAppDbId)
      await common.utils.dbReady(this.userAppDb)
    } catch (e) {
      if (this.isLoggedIn()) {
        throw e
      }
    }
  }

  _createSwarm (hub) {
    return swarm(hub, {
      config: this.config.swarmConfig
    })
  }

  startReplication () {
    debug('[masq.startReplication]')
    if (this.state !== 'logged') {
      return
    }

    this.userAppDb.discoveryKey.toString('hex')

    const discoveryKey = this.userAppDb.discoveryKey.toString('hex')
    this.userAppRepHub = signalhub(discoveryKey, this.config.hubUrls)
    this.userAppRepHub.on('error', () => {
      debug('[masq.startReplication] dispatched event: replicationError')
      this.eventTarget.dispatchEvent(new CustomEvent('replicationError', { detail: new MasqError(MasqError.REPLICATION_SIGNALLING_ERROR) }))
    })
    this.userAppRepSW = this._createSwarm(this.userAppRepHub)

    this.userAppRepSW.on('peer', (peer, id) => {
      try {
        const stream = this.userAppDb.replicate({ live: true })
        pump(peer, stream, peer)
      } catch (e) {
        if (this.isLoggedIn()) {
          throw e
        }
      }
    })

    this.replicating = true
  }

  async stopReplication () {
    debug('[masq.stopReplication]')
    if (!this.userAppRepSW) {
      return
    }
    await new Promise((resolve) => {
      this.userAppRepSW.close(() => {
        resolve()
      })
    })

    // reset replication variables
    this.userAppRepSW = null
    this.userAppRepHub = null

    this.replicating = false
  }

  isReplicating () {
    return this.replicating
  }

  isLoggedIn () {
    return (this.state === 'logged')
  }

  async getUsername () {
    const currentUserInfo = window.sessionStorage.getItem(CURRENT_USER_INFO_STR)
    if (!currentUserInfo) return null
    return JSON.parse(currentUserInfo).username
  }

  async getProfileImage () {
    const currentUserInfo = window.sessionStorage.getItem(CURRENT_USER_INFO_STR)
    if (!currentUserInfo) return null
    return JSON.parse(currentUserInfo).profileImage
  }

  async _genLoginLink () {
    this.loginChannel = uuidv4()
    this.loginKey = await common.crypto.genAESKey(true, 'AES-GCM', 128)
    const extractedKey = await common.crypto.exportKey(this.loginKey)
    const keyBase64 = Buffer.from(extractedKey).toString('base64')
    this.loginUrl = new URL(this.config.masqAppBaseUrl)
    const requestType = 'login'
    const hashParams = JSON.stringify([this.appName, requestType, this.loginChannel, keyBase64])
    this.loginUrl.hash = '/link/' + Buffer.from(hashParams).toString('base64')

    this.loginLink = this.loginUrl.href
  }

  async getLoginLink () {
    return this.loginLink
  }

  async logIntoMasq (stayConnected) {
    await this.setState('loggingIn')

    // make stayConnected i boolean
    this.stayConnected = !!stayConnected

    let pr = new Promise((resolve, reject) => {
      // Subscribe to channel for a limited time to sync with masq
      debug(`Creation of a hub with ${this.loginChannel} channel name`)

      const hub = signalhub(this.loginChannel, this.config.hubUrls)
      hub.on('error', ({ url, error }) => {
        reject(new MasqError(MasqError.SIGNALLING_SERVER_ERROR, url, error))
      })

      this.loginSw = this._createSwarm(hub)

      this.loginSw.on('peer', (peer, id) => {
        debug(`The peer ${id} join us...`)
        this.loginPeer = peer

        this.loginPeer.once('data', async (data) => {
          try {
            // decrypt the received message and check if the right key has been used
            const json = await common.crypto.decrypt(this.loginKey, JSON.parse(data), 'base64')
            // this._checkMessage(json, registering, waitingForWriteAccess)

            switch (json.msg) {
              case 'authorized':
                await this._receivedAuthorized(json)
                break

              case 'notAuthorized':
                // if this User-app is not registered
                await this._receiveNotAuthorized()
                break

              default:
                // TODO change error
                throw new MasqError(MasqError.WRONG_MESSAGE, `Unexpectedly received message with type ${json.msg}`)
            }
            resolve()
          } catch (e) {
            await this._resetLogin()
            reject(e)
          }
        })

        this.loginSwDisconnectListener = async (peer, id) => {
          debug('[masq.logIntoMasq] disconnect')
          reject(new MasqError(MasqError.DISCONNECTED_DURING_LOGIN))
        }
        this.loginSw.on('disconnect', this.loginSwDisconnectListener)

        this.loginSw.on('close', () => {
          debug('[masq.logIntoMasq] close')
        })
      })
    })

    try {
      await pr
      this.loginSw.close()
    } catch (e) {
      await this._resetLogin()
      throw e
    }
  }

  async _resetLogin () {
    debug('[masq._resetLogin]')
    this._deleteSessionInfo()

    // clear state
    this.stayConnected = false
    this.loginChannel = null
    this.loginKey = null
    this.loginUrl = null

    if (this.loginSw) {
      // remove disconnect listener
      if (this.loginSwDisconnectListener) {
        this.loginSw.removeListener('disconnect', this.loginSwDisconnectListener)
      }

      if (!this.loginSw.closed) {
        await new Promise((resolve) => {
          this.loginSw.close(() => {
            resolve()
          })
        })
      }
    }
    this.loginSw = null
    this.loginPeer = null
    this.username = null
    this.profileImage = null
    this.userAppDbId = null
    this.userAppDEK = null
    this.importedUserAppDEK = null
    this.userAppNonce = null
    this.userAppDb = null

    await this.stopReplication()

    await this._genLoginLink()

    await this.setState('notLogged')
  }

  async _receivedAuthorized (json) {
    debug('[masq._receiveAuthorized]')
    await this.setState('authorized')

    // TODO checkMessage

    const userAppDbId = json.userAppDbId

    // Check if the User-app is already registered
    const dbAlreadyExists = await common.utils.dbExists(userAppDbId)
    if (dbAlreadyExists) {
      await this._dbExists(json)
    } else {
      await this._dbUnknown()
    }
  }

  async _dbExists (json) {
    debug('[masq._dbExists]')

    // TODO checkMessage

    this.userAppDb = common.utils.createPromisifiedHyperDB(json.userAppDbId)
    await common.utils.dbReady(this.userAppDb)

    const encryptedMsg = await common.crypto.encrypt(
      this.loginKey,
      { msg: 'connectionEstablished' },
      'base64'
    )
    this.loginPeer.send(JSON.stringify(encryptedMsg))

    // Read session info into this state
    await this._readSessionInfoIntoState(json)

    await this.setState('logged')
  }

  async _readSessionInfoIntoState (userInfoJson) {
    const { userAppDbId, userAppDEK, userAppNonce, username, profileImage } = userInfoJson
    this.username = username
    this.profileImage = profileImage

    this.userAppDbId = userAppDbId
    this.userAppDEK = userAppDEK

    if (userAppDEK) {
      // store the dataEncryptionKey as a CryptoKey
      this.importedUserAppDEK = await common.crypto.importKey(Buffer.from(userAppDEK, 'hex'))
    }

    this.userAppNonce = userAppNonce
  }

  _storeSessionInfo () {
    // Store the session info
    const currentUserInfo = {
      userAppDbId: this.userAppDbId,
      userAppDEK: this.userAppDEK,
      username: this.username,
      profileImage: this.profileImage,
      userAppNonce: this.userAppNonce
    }

    if (this.stayConnected) {
      window.localStorage.setItem(CURRENT_USER_INFO_STR, JSON.stringify(currentUserInfo))
    }
    window.sessionStorage.setItem(CURRENT_USER_INFO_STR, JSON.stringify(currentUserInfo))
  }

  _deleteSessionInfo () {
    window.localStorage.removeItem(CURRENT_USER_INFO_STR)
    window.sessionStorage.removeItem(CURRENT_USER_INFO_STR)
  }

  async _dbUnknown () {
    debug('[masq._dbUnknown]')
    await this._registerNeeded()
  }

  async _receiveNotAuthorized () {
    debug('[masq._receiveNotAuthorized]')
    await this._registerNeeded()
  }

  async _registerNeeded () {
    debug('[masq._registerNeeded]')
    await this.setState('registerNeeded')

    const msg = {
      msg: 'registerUserApp',
      name: this.appName,
      description: this.appDescription,
      imageURL: this.appImageURL
    }
    let encryptedMsg = await common.crypto.encrypt(this.loginKey, msg, 'base64')
    this.loginPeer.send(JSON.stringify(encryptedMsg))

    const pr = new Promise((resolve, reject) => {
      this.loginPeer.once('data', async (data) => {
        try {
          // decrypt the received message and check if the right key has been used
          const json = await common.crypto.decrypt(this.loginKey, JSON.parse(data), 'base64')
          // this._checkMessage(json, registering, waitingForWriteAccess)

          switch (json.msg) {
            case 'masqAccessGranted':
              await this._registering(json)
              break

            case 'masqAccessRefused':
              await this._userRefusedAccess()
              break

            default:
              throw new MasqError(MasqError.WRONG_MESSAGE, `Unexpectedly received message with type ${json.msg}`)
          }
        } catch (err) {
          await this._resetLogin()
          reject(err)
        }
        resolve()
      })
    })

    await pr
  }

  async _userRefusedAccess () {
    debug('[masq._userRefusedAccess]')
    await this._resetLogin()
    throw new MasqError(MasqError.MASQ_ACCESS_REFUSED_BY_USER)
  }

  async _registering (json) {
    debug('[masq._registering]')
    await this.setState('accessMaterialReceived')

    // TODO checkMessage

    // Read session info into this state
    this._readSessionInfoIntoState(json)

    const buffKey = Buffer.from(json.key, 'hex')
    const db = common.utils.createPromisifiedHyperDB(json.userAppDbId, buffKey)
    await common.utils.dbReady(db)

    const msg = {
      msg: 'requestWriteAccess',
      key: db.local.key.toString('hex')
    }
    const encryptedMsg = await common.crypto.encrypt(this.loginKey, msg, 'base64')
    this.loginPeer.send(JSON.stringify(encryptedMsg))

    const pr = new Promise((resolve, reject) => {
      this.loginPeer.once('data', async (data) => {
        try {
          // decrypt the received message and check if the right key has been used
          const json = await common.crypto.decrypt(this.loginKey, JSON.parse(data), 'base64')
          // this._checkMessage(json, registering, waitingForWriteAccess)

          switch (json.msg) {
            case 'writeAccessGranted':
              await this._dbCreation()
              break

            default:
              throw new MasqError(MasqError.WRONG_MESSAGE, `Unexpectedly received message with type ${json.msg}`)
          }
        } catch (err) {
          await this._resetLogin()
          reject(err)
        }
        resolve()
      })
    })

    await pr
  }

  async _dbCreation () {
    debug('[masq._dbCreation]')
    await this.setState('userAppDbCreated')

    await this._openDb()

    const msg = {
      msg: 'connectionEstablished'
    }
    const encryptedMsg = await common.crypto.encrypt(this.loginKey, msg, 'base64')

    this.loginPeer.send(JSON.stringify(encryptedMsg))

    await this._awaitReadyMsg()
  }

  async _awaitReadyMsg () {
    debug('[masq._awaitReadyMsg]')
    // TODO : should we really await a 'ready' message when register ?

    await this.setState('logged')
  }

  async signout () {
    this.userAppDbId = null
    this.userAppDb = null

    await this._resetLogin()

    debug('[masq.signout] dispatched event: signed_out')
    this.eventTarget.dispatchEvent(new Event('signed_out'))
  }

  async watch (key, cb) {
    debug('[masq.watch] logged : ' + this.isLoggedIn())
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    return common.utils.watch(this.userAppDb, this.userAppNonce, key, cb)
  }

  async get (key) {
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    return common.utils.get(this.userAppDb, this.importedUserAppDEK, this.userAppNonce, key)
  }

  async put (key, value) {
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    return common.utils.put(this.userAppDb, this.importedUserAppDEK, this.userAppNonce, key, value)
  }

  async del (key) {
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    const hashedKey = await common.utils.hashKey(key, this.userAppNonce)
    return this.userAppDb.delAsync(hashedKey)
  }

  async list (prefix) {
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    return common.utils.list(this.userAppDb, this.importedUserAppDEK, this.userAppNonce, prefix)
  }
}

module.exports = {
  Masq,
  MasqError
}
