const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
const common = require('masq-common')
window.crypto = require('@trust/webcrypto')

const Masq = require('../src')
const MasqAppMock = require('./mockMasqApp')
const testConfig = require('../config/config.test.json')

const APP_NAME = 'app1'
const APP_DESCRIPTION = 'A wonderful app'
const APP_IMAGE_URL = ' a link to image'

const { dbExists, createPromisifiedHyperDB, resetDbList } = common.utils
const { genRandomBuffer } = common.crypto
const ERRORS = common.errors.ERRORS

let server = null
let masq = null
let mockMasqApp = null

jest.setTimeout(30000)

// user an in memory random-access-storage instead
jest.mock('random-access-idb', () =>
  () => require('random-access-memory'))

jest.mock('masq-common', () => {
  const hyperdb = require('hyperdb')
  const ram = require('random-access-memory')
  const { promisify } = require('es6-promisify')
  const original = require.requireActual('masq-common')

  // Same function as original, but use ram instead
  const createPromisifiedHyperDBMock = (name, hexKey) => {
    const methodsToPromisify = ['version', 'put', 'get', 'del', 'batch', 'list', 'authorize', 'authorized']
    const keyBuffer = hexKey
      ? Buffer.from(hexKey, 'hex')
      : null

    const db = hyperdb(ram, keyBuffer, { valueEncoding: 'json', firstNode: true })

    // Promisify methods with Async suffix
    methodsToPromisify.forEach(m => {
      db[`${m}Async`] = promisify(db[m])
    })

    return db
  }

  return {
    ...original,
    dbList: {},
    utils: {
      ...original.utils,
      dbExists: (name) => Promise.resolve(!!this.dbList[name]),
      createPromisifiedHyperDB: (name, hexKey) => {
        this.dbList[name] = 'db'
        return createPromisifiedHyperDBMock(name, hexKey)
      },
      resetDbList: () => {
        this.dbList = {}
      }
    }
  }
})

function getHashParams (link) {
  const url = new URL(link)
  const hash = url.hash.slice(7)
  const hashParamsArr = JSON.parse(Buffer.from(hash, 'base64').toString('utf8'))
  if (!Array.isArray(hashParamsArr) || hashParamsArr.length !== 4) {
    throw new Error('Wrong login URL')
  }
  const hashParamsObj = {
    appName: hashParamsArr[0],
    requestType: hashParamsArr[1],
    channel: hashParamsArr[2],
    key: hashParamsArr[3]
  }
  hashParamsObj.key = Buffer.from(hashParamsObj.key, 'base64')
  return hashParamsObj
}

async function logInWithMasqAppMock (stayConnected) {
  // stop replication if logInWithMasqAppMock has already been called
  mockMasqApp.destroy()

  const link = await masq.getLoginLink()
  const hashParams = getHashParams(link)

  await Promise.all([
    mockMasqApp.handleConnectionAuthorized(hashParams.channel, hashParams.key),
    masq.logIntoMasq(stayConnected)
  ])
}

beforeAll((done) => {
  server = signalserver()
  server.listen(8080, (err) => {
    if (err) throw err
    done()
  })
})

afterAll((done) => {
  server.close(done)
})

beforeEach(async () => {
  masq = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
  mockMasqApp = new MasqAppMock()
  await mockMasqApp.init()
})

afterEach(async () => {
  await masq.signout()
  mockMasqApp.destroy()
  resetDbList()
})

describe('localStorage and sessionStorage', () => {
  test('check that localStorage exists', () => {
    window.localStorage.setItem('testKey', 'testValue')
    expect(window.localStorage.getItem('testKey')).toBe('testValue')
    window.localStorage.clear()
  })

  test('check that sessionStorage exists', () => {
    window.sessionStorage.setItem('testKey', 'testValue')
    expect(window.sessionStorage.getItem('testKey')).toBe('testValue')
    window.sessionStorage.clear()
  })
})

describe('Mock functions', () => {
  test('dbExists should work as expected', async () => {
    expect(await dbExists('db1')).toBe(false)
    await createPromisifiedHyperDB('db1')
    expect(await dbExists('db1')).toBe(true)
    resetDbList()
    expect(await dbExists('db1')).toBe(false)
    await createPromisifiedHyperDB('db1')
    expect(await dbExists('db1')).toBe(true)
  })
})

describe('Login procedure', () => {
  test('should generate a pairing link', async () => {
    const uuidSize = 36
    const link = await masq.getLoginLink()
    const url = new URL(link)
    const base = testConfig.masqAppBaseUrl
    expect(url.origin + url.pathname).toBe(base)
    const hashParams = getHashParams(link)
    expect(hashParams.channel).toHaveLength(uuidSize)
  })

  test('should join a channel', async () => {
    let peersLength

    const waitForPeer = new Promise(async (resolve, reject) => {
      const link = await masq.getLoginLink()
      const hashParams = getHashParams(link)

      // simulating masq app
      const hub = signalhub(hashParams.channel, testConfig.hubUrls)
      const sw = swarm(hub, { wrtc })

      sw.on('peer', (peer, id) => {
        peersLength = sw.peers.length
        sw.close()
      })

      sw.on('close', () => {
        resolve()
      })
    })

    await Promise.all([waitForPeer, masq.logIntoMasq(false)])
    expect(peersLength).toBe(1)
  })

  test('isLoggedIn and isConnected should return false', async () => {
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('isLoggedIn and isConnected should return true after successful login', async () => {
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)
  })

  test('should login and signout correctly', async () => {
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
    await logInWithMasqAppMock(true)
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)
    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should be able to connect with new Masq instance after logging in with stayConnected and disconnecting', async () => {
    expect(masq.isLoggedIn()).toBe(false)
    await logInWithMasqAppMock(true)

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    const res = await masq.get(key)
    expect(res).toEqual(value)
    expect(masq.isLoggedIn()).toBe(true)
    await masq._disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    // reconnect with new Masq instance
    const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
    expect(masq2.isLoggedIn()).toBe(true)
    expect(masq2.isConnected()).toBe(false)
    await masq2.connectToMasq()
    expect(masq2.isLoggedIn()).toBe(true)
    expect(masq2.isConnected()).toBe(true)
    const key2 = '/hello2'
    const value2 = { data: 'world2' }
    await masq2.put(key2, value2)
    expect(await masq2.get(key2)).toEqual(value2)

    // signout
    await masq2.signout()
  })

  test('should not be able to connect with new Masq instance after logging in without stayConnected and disconnecting', async () => {
    expect(masq.isLoggedIn()).toBe(false)
    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).toBe(true)
    await masq._disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    // reconnect with new Masq instance (masq2)
    const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
    expect(masq2.isLoggedIn()).toBe(false)
    expect(masq2.isConnected()).toBe(false)

    await expect(masq2.connectToMasq())
      .rejects
      .toHaveProperty('type', ERRORS.NOT_LOGGED_IN)

    expect(masq2.isLoggedIn()).toBe(false)
    expect(masq2.isConnected()).toBe(false)

    // connect with masq2
    mockMasqApp.destroy()
    const link = await masq2.getLoginLink()
    const hashParams = getHashParams(link)
    await Promise.all([
      mockMasqApp.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq2.logIntoMasq(false)
    ])

    expect(masq2.isLoggedIn()).toBe(true)
    expect(masq2.isConnected()).toBe(true)

    // put with masq2
    const key = '/hello'
    const value = { data: 'world' }
    await masq2.put(key, value)
    const res = await masq2.get('/hello')
    expect(res).toEqual(value)

    // signout with masq2
    await masq2.signout()
  })

  test('should be able to repeat login-disconnect-connect-signout', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    for (let i = 0; i < 2; i++) {
      await logInWithMasqAppMock(false)
      expect(masq.isLoggedIn()).toBe(true)
      expect(masq.isConnected()).toBe(true)

      await masq._disconnect()
      expect(masq.isLoggedIn()).toBe(true)
      expect(masq.isConnected()).toBe(false)

      await masq.connectToMasq()
      expect(masq.isLoggedIn()).toBe(true)
      expect(masq.isConnected()).toBe(true)

      await masq.signout()
      expect(masq.isLoggedIn()).toBe(false)
      expect(masq.isConnected()).toBe(false)
    }
  })

  test('should fail when connect without prior login', async () => {
    expect(masq.isLoggedIn()).toBe(false)
    await expect(masq.connectToMasq())
      .rejects
      .toHaveProperty('type', ERRORS.NOT_LOGGED_IN)

    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should fail when connect after signout without prior login', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq._disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)

    // Trying to reconnect without login should fail
    await expect(masq.connectToMasq())
      .rejects
      .toHaveProperty('type', ERRORS.NOT_LOGGED_IN)

    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should be able to disconnect even if not logged in nor connected', async () => {
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
    await masq._disconnect()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should be able to disconnect more than once, then reconnect without error', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq._disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq._disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)
  })

  test('should be able to connect more than once without error', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq._disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)
  })

  test('should be able to sign out more than once without error', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should be able to login more than once without error', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)
  })

  test('should be kicked if key is invalid', async () => {
    const link = await masq.getLoginLink()
    const hashParams = getHashParams(link)
    const invalidKey = 'wrongChallenge'

    const promiseAll = Promise.all([
      mockMasqApp.handleConnectionAuthorized(hashParams.channel, invalidKey),
      masq.logIntoMasq(false)
    ])

    await expect(promiseAll)
      .rejects
      .toHaveProperty('type', ERRORS.INVALID_KEY)
  })

  test('should be kicked if wrong key is used', async () => {
    const link = await masq.getLoginLink()
    const hashParams = getHashParams(link)
    // Extracted raw key is only a BUffer of bytes.
    const extractedWrongKey = Buffer.from(genRandomBuffer(16))
    const promiseAll = Promise.all([
      mockMasqApp.handleConnectionAuthorized(hashParams.channel, extractedWrongKey),
      masq.logIntoMasq(false)
    ])

    await expect(promiseAll)
      .rejects
      .toHaveProperty('type', ERRORS.UNABLE_TO_DECRYPT)
  })

  test('should fail when register is refused', async () => {
    const link = await masq.getLoginLink()
    const hashParams = getHashParams(link)

    const promiseAll = Promise.all([
      mockMasqApp.handleConnectionRegisterRefused(hashParams.channel, hashParams.key),
      masq.logIntoMasq(false)
    ])

    await expect(promiseAll)
      .rejects
      .toHaveProperty('type', ERRORS.MASQ_ACCESS_REFUSED_BY_USER)
  })
})

// TODO add tests for unexpected message received
// TODO add tests for connect-disconnect-connect

describe('Test data access and input', () => {
  test('operations should fail if masq is not connected', async () => {
    const functions = [ 'watch' ]
    const promises = [
      masq.get('key'),
      masq.put('key', 'value'),
      masq.del('key'),
      masq.list('/')
    ]
    let err

    for (let p of promises) {
      await expect(p)
        .rejects
        .toHaveProperty('type', ERRORS.NOT_CONNECTED)
    }

    functions.forEach(f => {
      try {
        masq[f]()
      } catch (e) {
        err = e
      }
      expect(err.type).toBe(ERRORS.NOT_CONNECTED)
    })
  })

  test('put/get should put and get an item', async () => {
    await logInWithMasqAppMock(false)
    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    const res = await masq.get('/hello')
    expect(res).toEqual(value)
  })

  // By default hyperDB list method returns key="" value=null if no put has been done
  test('list should return {} if empty (with no parameter)', async () => {
    await logInWithMasqAppMock(false)
    const res = await masq.list()
    expect(res).toEqual({})
  })

  // By default hyperDB list method returns key="" value=null if no put has been done
  test('list should return {} if empty (with "/" as parameter)', async () => {
    await logInWithMasqAppMock(false)
    const res = await masq.list()
    expect(res).toEqual({})
  })

  test('list should get every put items', async () => {
    await logInWithMasqAppMock(false)
    const keyValues = {
      'hello': { data: 'world' },
      'hello1': { data: 'world1' },
      'hello2': { data: 'world2' },
      'hello3': { data: 'world3' }
    }
    const promiseArr = Object.keys(keyValues).map(k =>
      masq.put(k, keyValues[k])
    )
    await Promise.all(promiseArr)
    await masq.del('hello2')
    const res = await masq.list('/')

    const expected = Object.keys(keyValues).reduce((dic, k) => {
      if (k !== 'hello2') dic[k] = keyValues[k]
      return dic
    }, {})

    expect(res).toEqual(expected)
  })

  test('del should del an item', async () => {
    await logInWithMasqAppMock(false)
    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    await masq.del(key)
    const res = await masq.get('/hello')
    expect(res).toBeNull()
  })

  test('should set a watcher', async () => {
    let resolveOnChange
    const waitForChange = new Promise((resolve) => { resolveOnChange = resolve })

    await logInWithMasqAppMock(false)
    const key = '/hello'
    const value = { data: 'world' }
    masq.watch('/hello', resolveOnChange)
    await masq.put(key, value)
    await waitForChange
  })

  test('should be able to get a notif on change in masq-app with a watcher on masq-lib', async () => {
    let resolveOnChange
    const waitForChange = new Promise((resolve) => { resolveOnChange = resolve })

    await logInWithMasqAppMock(false)
    const key = '/hello'
    const value = { data: 'world' }
    masq.watch('/hello', resolveOnChange)
    await mockMasqApp.put(masq.userId, key, value)
    await waitForChange
  })
})

describe('Test replication', () => {
  test('put/get should put an item and get in Mock Masq App', async () => {
    await logInWithMasqAppMock(false)

    let resolveOnChange
    const waitForChange = new Promise((resolve) => { resolveOnChange = resolve })
    mockMasqApp.watch(masq.userId, '/hello', resolveOnChange)

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    await waitForChange
    const res = await mockMasqApp.get(masq.userId, '/hello')
    expect(res).toEqual(value)
  })
})
