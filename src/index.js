const { Machine, interpret, assign, send } = require('xstate')

const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const uuidv4 = require('uuid/v4')

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
  get eventTarget () {
    return this.service.machine.context.eventTarget
  }

  constructor (appName, appDescription, appImageURL, config = {}) {
    const eventTarget = document.createElement('MasqLib')
    this.machine = Machine({
      id: 'Masq',
      initial: 'notInitialized',
      context: {
        appName,
        appDescription,
        appImageURL,
        config,
        eventTarget
      },
      strict: true,
      on: {
        SIGNALLING_SERVER_ERROR: 'loginFailed',
        SW_CLOSED_DURING_LOGIN: 'loginFailed'
      },
      states: {
        notInitialized: {
          invoke: {
            id: 'init',
            src: _init,
            onDone: {
              target: 'notLogged',
              actions: [ _sendReady ]
            },
            onError: {
              target: 'initError'
            }
          }
        },
        initError: {
        },
        notLogged: {
          on: {
            LOGIN_START: 'loggingIn'
          }
        },
        loggingIn: {
          invoke: {
            id: 'startingLogin',
            src: _startLogin
          },
          on: {
            DISCONNECTED: 'loginFailed',
            AUTHORIZED: 'authorized',
            NOT_AUTHORIZED: 'registerNeeded'
          }
        },
        registerNeeded: {
          invoke: {
            src: _registerNeeded
          },
          on: {
            MASQ_ACCESS_GRANTED: 'accessMaterialReceived',
            MASQ_ACCESS_REFUSED: 'loginFailed'
          }
        },
        accessMaterialReceived: {
          invoke: {
            src: _registering
          },
          on: {
            WRITE_ACCESS_GRANTED: 'userAppDbCreated'
          }
        },
        userAppDbCreated: {
          invoke: {
            src: _dbCreation
          },
          on: {
            CONNECTION_ESTABLISHED: 'connectionEstablished'
          }
        },
        authorized: {
          invoke: {
            src: _receivedAuthorized
          },
          on: {
            CONNECTION_ESTABLISHED: 'connectionEstablished',
            REGISTER_NEEDED: 'registerNeeded'
          }
        },
        loginFailed: {
          actions: [ _resetLogin ],
          target: 'notLogged'
        },
        connectionEstablished: {
          invoke: {
            src: _readSessionInfoIntoState,
            onDone: 'logged'
          }
        },
        logged: {
          on: {
            SIGNOUT: {
              target: 'notLogged',
              actions: [_signout]
            }
          }
        }
      }
    })

    this.service = interpret(this.machine)

    this.service.onTransition(state => {
      console.log('NEW STATE : ' + state.value)
    })

    this.service.start()
    console.log('STARTED')

    // setup listeners
    this._listenForLoginOrSignout()
    this._listenForFocus()
  }

  async init () {
    await new Promise((resolve) => {
      this.eventTarget.addEventListener(
        'ready',
        () => { resolve() },
        { once: true }
      )
    })
  }

  async logIntoMasq (stayConnected) {
    console.log('[logIntoMasq]')
    this.service.send({
      type: 'LOGIN_START',
      stayConnected
    })
    await new Promise((resolve, reject) => {
      this.service.onTransition(state => {
        if (state.value === 'logged') {
          resolve()
        } else if (state.value === 'loginFailed') {
          console.log('logIntoMasq: loginFailed')
          reject(new MasqError(MasqError.DISCONNECTED_DURING_LOGIN))
        }
      })
    })
    console.log('[logIntoMasq] done')
  }

  _listenForLoginOrSignout () {
    window.addEventListener('storage', async (e) => {
      if (e.key === CURRENT_USER_INFO_STR) {
        if (e.newValue === null) {
          this.service.send('USER_INFO_DELETED')
          debug('[masq._listenForLoginOrSignout] detected signout from another window/tab')
        } else if (e.newValue) {
          this.service.send('USER_INFO_STORED')
          debug('[masq._listenForLoginOrSignout] detected login from another window/tab')
        }
      }
    })
  }

  _listenForFocus () {
    document.addEventListener('focus', async () => {
      this.service.send('FOCUS')
    })
  }

  async signout () {
    console.log('[Masq.signout]')
    this.service.send({
      type: 'SIGNOUT'
    })
  }

  async getLoginLink () {
    return this.service.machine.context.loginLink
  }

  async isLoggedIn () {
    this.service.machine.state.matches('logged')
  }

  async put (key, value) {
    const { userAppDb, importedUserAppDEK, userAppNonce } = this.service.machine.context
    return common.utils.put(
      userAppDb,
      importedUserAppDEK,
      userAppNonce,
      key,
      value
    )
  }

  async get (key) {
    const { userAppDb, importedUserAppDEK, userAppNonce } = this.service.machine.context
    return common.utils.get(
      userAppDb,
      importedUserAppDEK,
      userAppNonce,
      key
    )
  }

  async del (key) {
    const { userAppDb, importedUserAppDEK, userAppNonce } = this.service.machine.context
    return common.utils.del(
      userAppDb,
      importedUserAppDEK,
      userAppNonce,
      key
    )
  }

  async list (prefix) {
    const { userAppDb, importedUserAppDEK, userAppNonce } = this.service.machine.context
    return common.utils.list(
      userAppDb,
      importedUserAppDEK,
      userAppNonce,
      prefix
    )
  }

  async watch (key, cb) {
    const { userAppDb, userAppNonce } = this.service.machine.context
    return common.utils.watch(
      userAppDb,
      userAppNonce,
      key,
      cb
    )
  }
}

const _resetLogin = () => {
  console.log('--- RESET LOGIN ---')
}

const _init = async (context, event, actionMeta) => {
  // override config with options argument
  context.config = {
    hubUrls: context.config.hubUrls || jsonConfig.hubUrls,
    masqAppBaseUrl: context.config.masqAppBaseUrl || jsonConfig.masqAppBaseUrl,
    swarmConfig: context.config.swarmConfig || jsonConfig.swarmConfig,
    ...getNullAttributes()
  }

  // try to login from session info
  // await this._loadSessionInfo()

  assign(context)
  await _genLoginLink(context)
}

const getNullAttributes = () => {
  const nullAttributes = {}

  // login state data
  nullAttributes.stayConnected = false
  nullAttributes.loginSw = null
  nullAttributes.loginPeer = null

  // reset replication variables
  nullAttributes.replicating = false
  nullAttributes.userAppRepSW = null
  nullAttributes.userAppRepHub = null

  // reset logged in user variable
  nullAttributes.userAppDbId = null
  nullAttributes.userAppDb = null
  nullAttributes.userAppDEK = null
  nullAttributes.importedUserAppDEK = null
  nullAttributes.userAppNonce = null
  nullAttributes.username = null
  nullAttributes.profileImage = null

  return nullAttributes
}

const _startLogin = (context, event, actionMeta) => (callbackParent, onEvent) => {
  // make stayConnected a boolean
  context.stayConnected = !!event.stayConnected

  // Subscribe to channel for a limited time to sync with masq
  debug(`Creation of a hub with ${context.loginChannel} channel name`)

  const hub = signalhub(context.loginChannel, context.config.hubUrls)
  hub.on('error', ({ url, error }) => {
    send('SIGNALLING_SERVER_ERROR')
    // reject(new MasqError(MasqError.SIGNALLING_SERVER_ERROR, url, error))
  })

  context.loginSw = swarm(hub, {
    config: context.config.swarmConfig
  })
  assign(context)

  context.loginSw.on('peer', (peer, id) => {
    debug(`The peer ${id} joined us...`)
    const loginPeer = peer

    loginPeer.once('data', async (data) => {
      debug('[masq.logIntoMasq] on data')
      // decrypt the received message and check if the right key has been used
      const json = await common.crypto.decrypt(context.loginKey, JSON.parse(data), 'base64')
      console.log('MESSAGE: ', json)

      switch (json.msg) {
        case 'authorized':
          callbackParent({
            type: 'AUTHORIZED',
            loginPeer,
            loginJson: json
          })
          break

        case 'notAuthorized':
          // if this User-app is not registered
          callbackParent({
            type: 'NOT_AUTHORIZED',
            peer: loginPeer
          })
          break

        default:
          // TODO change error
          callbackParent({
            type: 'WRONG_MESSAGE',
            errorMessage: `Unexpectedly received message with type ${json.msg}`,
            peer: loginPeer
          })
      }
    })

    context.loginSw.on('disconnect', (peer, id) => {
      debug('[masq.logIntoMasq] disconnect')
      callbackParent('DISCONNECTED')
    })

    context.loginSw.on('close', () => {
      debug('[masq.logIntoMasq] close')
      send('SW_CLOSED_DURING_LOGIN')
    })
  })
}

const _signout = (context, event) => {
}

// TODO check login link lifecycle
const _genLoginLink = async (context) => {
  console.log('[_genLoginLink]')
  context.loginChannel = uuidv4()
  context.loginKey = await common.crypto.genAESKey(true, 'AES-GCM', 128)
  const extractedKey = await common.crypto.exportKey(context.loginKey)
  const keyBase64 = Buffer.from(extractedKey).toString('base64')
  const loginUrl = new URL(context.config.masqAppBaseUrl)
  const requestType = 'login'
  const hashParams = JSON.stringify([context.appName, requestType, context.loginChannel, keyBase64])
  loginUrl.hash = '/link/' + Buffer.from(hashParams).toString('base64')

  context.loginLink = loginUrl.href

  assign(context)
}

const _sendReady = async (context) => {
  console.log('[_sendReady]')
  context.eventTarget.dispatchEvent(new Event('ready'))
}

const _receivedAuthorized = (context, event) => async (cbParent) => {
  debug('[_receiveAuthorized]')

  context.loginPeer = event.loginPeer
  assign(context)

  // TODO checkMessage

  // Check if the User-app is already registered
  const dbAlreadyExists = await common.utils.dbExists(context.userAppDbId)

  if (dbAlreadyExists) {
    const userAppDb = common.utils.createPromisifiedHyperDB(event.loginJson.userAppDbId)
    await common.utils.dbReady(userAppDb)

    const encryptedMsg = await common.crypto.encrypt(
      context.loginKey,
      { msg: 'connectionEstablished' },
      'base64'
    )
    context.loginPeer.send(JSON.stringify(encryptedMsg))

    cbParent({
      type: 'CONNECTION_ESTABLISHED',
      loginJson: event.loginJson
    })
  } else {
    cbParent('REGISTER_NEEDED')
  }
}

const _registerNeeded = (context) => async (cbParent) => {
  debug('[masq._registerNeeded]')

  const msg = {
    msg: 'registerUserApp',
    name: context.appName,
    description: context.appDescription,
    imageURL: context.appImageURL
  }
  let encryptedMsg = await common.crypto.encrypt(context.loginKey, msg, 'base64')
  context.loginPeer.send(JSON.stringify(encryptedMsg))

  context.loginPeer.once('data', async (data) => {
    // decrypt the received message and check if the right key has been used
    const json = await common.crypto.decrypt(context.loginKey, JSON.parse(data), 'base64')

    switch (json.msg) {
      case 'masqAccessGranted':
        console.log('MSG => masqAccessGranted')
        cbParent({
          type: 'MASQ_ACCESS_GRANTED',
          loginJson: json
        })
        break

      case 'masqAccessRefused':
        cbParent('MASQ_ACCESS_REFUSED')
        break

      default:
        cbParent({
          type: 'WRONG_MESSAGE',
          detail: `Unexpectedly received message with type ${json.msg}`
        })
    }
  })
}

const _registering = (context, event) => async (cbParent) => {
  debug('[masq._registering]')

  // TODO checkMessage

  const buffKey = Buffer.from(event.loginJson.key, 'hex')
  context.userAppDb = common.utils.createPromisifiedHyperDB(event.loginJson.userAppDbId, buffKey)
  await common.utils.dbReady(context.userAppDb)

  const msg = {
    msg: 'requestWriteAccess',
    key: context.userAppDb.local.key.toString('hex')
  }
  const encryptedMsg = await common.crypto.encrypt(context.loginKey, msg, 'base64')
  context.loginPeer.send(JSON.stringify(encryptedMsg))

  context.loginPeer.once('data', async (data) => {
    try {
      // decrypt the received message and check if the right key has been used
      const json = await common.crypto.decrypt(context.loginKey, JSON.parse(data), 'base64')

      switch (json.msg) {
        case 'writeAccessGranted':
          cbParent({
            type: 'WRITE_ACCESS_GRANTED',
            loginJson: event.loginJson
          })
          break

        default:
          cbParent({
            type: 'WRONG_MESSAGE',
            details: `Unexpectedly received message with type ${json.msg}`
          })
      }
    } catch (err) {
      cbParent({
        type: 'LOGIN_FAILED',
        error: err
      })
    }
  })
}

const _readSessionInfoIntoState = async (context, event) => {
  const userInfoJson = event.loginJson

  const { userAppDbId, userAppDEK, userAppNonce, username, profileImage } = userInfoJson
  context.username = username
  context.profileImage = profileImage

  context.userAppDbId = userAppDbId
  context.userAppDEK = userAppDEK

  if (userAppDEK) {
    // store the dataEncryptionKey as a CryptoKey
    context.importedUserAppDEK = await common.crypto.importKey(Buffer.from(userAppDEK, 'hex'))
  }

  context.userAppNonce = userAppNonce
  assign(context)
}

const _dbCreation = (context, event) => async (cbParent) => {
  debug('[masq._dbCreation]')

  const msg = {
    msg: 'connectionEstablished'
  }
  const encryptedMsg = await common.crypto.encrypt(context.loginKey, msg, 'base64')

  context.loginPeer.send(JSON.stringify(encryptedMsg))
  cbParent({
    type: 'CONNECTION_ESTABLISHED',
    loginJson: event.loginJson
  })
}

module.exports = {
  Masq,
  MasqError
}
