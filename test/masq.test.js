const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
window.crypto = require('@trust/webcrypto')
const common = require('../node_modules/masq-common/dist/index')

const Masq = require('../src')
const MasqAppMock = require('./mockMasqApp')
const config = require('../config/config')

const APP_NAME = 'app1'
const APP_DESCRIPTION = 'A wonderful app'
const APP_IMAGE_URL = ' a link to image'
console.log(common)

// user an in memory random-access-storage instead
jest.mock('random-access-idb', () =>
  () => require('random-access-memory'))

jest.mock('../node_modules/masq-common/dist/index', () => {
  const original = require.requireActual('../node_modules/masq-common/dist/index')
  let dbList = {}
  let originalCreate = original.utils.createPromisifiedHyperDB
  let modified = { ...original }
  modified.utils.dbExists = (name) => {
    return Promise.resolve(!!dbList[name])
  }
  modified.utils.createPromisifiedHyperDB = (name, hexKey) => {
    dbList[name] = 'db'
    return originalCreate(name, hexKey)
  }
  modified.utils.resetDbList = () => {
    dbList = {}
  }
  return modified
})

let server = null
let masq = null
let mockMasqApp = null

jest.setTimeout(30000)

beforeAll(async () => {
  server = signalserver()
  await new Promise((resolve) => {
    server.listen(8080, (err) => {
      if (err) throw err
      resolve()
    })
  })
})

afterAll((done) => {
  server.close(done)
})

beforeEach(() => {
  masq = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
  mockMasqApp = new MasqAppMock()
})

afterEach(async () => {
  await masq.signout()
  mockMasqApp.destroy()
  common.utils.resetDbList()
})

describe('Test mock functions', () => {
  test('dbExists should work as expected', async () => {
    expect(await common.utils.dbExists('db1')).toBe(false)
    try {
      await common.utils.createPromisifiedHyperDB('db1')
      expect(await common.utils.dbExists('db1')).toBe(true)
    } catch (error) {
      console.log(error)
    }
    common.utils.resetDbList()
    expect(await common.utils.dbExists('db1')).toBe(false)
    await common.utils.createPromisifiedHyperDB('db1')
    expect(await common.utils.dbExists('db1')).toBe(true)
  })
})

function getHashParams (url) {
  const hash = url.hash.slice(2)
  const hashParamsArr = JSON.parse(Buffer.from(hash, 'base64').toString('utf8'))
  const hashParamsObj = {
    appName: hashParamsArr[0],
    requestType: hashParamsArr[1],
    channel: hashParamsArr[2],
    key: hashParamsArr[3]
  }
  hashParamsObj.key = Buffer.from(hashParamsObj.key, 'base64')
  return hashParamsObj
}

async function logInWithMasqAppMock () {
  // stop replication if logInWithMasqAppMock has already been called
  mockMasqApp.destroy()

  const { link } = await masq.logIntoMasq(true)
  const url = new URL(link)
  const hashParams = getHashParams(url)

  await Promise.all([
    mockMasqApp.handleConnectionAuthorized(hashParams.channel, hashParams.key),
    masq.logIntoMasqDone()
  ])
}

describe('Test login procedure', () => {
  test('should generate a pairing link', async () => {
    const uuidSize = 36
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const base = config.MASQ_APP_BASE_URL
    expect(url.origin + url.pathname).toBe(base)
    const hashParams = getHashParams(url)
    expect(hashParams.channel).toHaveLength(uuidSize)
  })

  test('should join a channel', async () => {
    expect.assertions(1)

    const pr = new Promise(async (resolve, reject) => {
      const { link } = await masq.logIntoMasq()
      const url = new URL(link)
      const hashParams = getHashParams(url)

      // simulating masq app
      const hub = signalhub(hashParams.channel, config.HUB_URLS)
      const sw = swarm(hub, { wrtc })

      sw.on('peer', (peer, id) => {
        expect(sw.peers).toHaveLength(1)
        sw.close()
      })

      sw.on('close', () => {
        resolve()
      })
    })
    await pr
    await masq.logIntoMasqDone()
  })

  test('should connect to Masq with key passed through url param', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock()

    expect(masq.isLoggedIn()).toBe(true)
  })

  /*
  test('should be able to connect with new Masq instance after logging in with stayConnected and disconnecting', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock()

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    const res = await masq.get(key)
    expect(res).toEqual(value)

    expect(masq.isLoggedIn()).toBe(true)
    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    // reconnect with new Masq instance
    const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
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

    // fail to reconnect without logging in
    const masq3 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
    expect(masq3.isLoggedIn()).toBe(false)
    expect(masq3.isConnected()).toBe(false)
    await masq3.signout()
  })
  */

  /*
  test('should not be able to connect with new Masq instance after logging in without stayConnected and disconnecting', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock()

    expect(masq.isLoggedIn()).toBe(true)
    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    // reconnect with new Masq instance
    const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
    expect(masq2.isLoggedIn()).toBe(true)
    expect(masq2.isConnected()).toBe(false)
    await masq2.connectToMasq()
    expect(masq2.isLoggedIn()).toBe(true)
    expect(masq2.isConnected()).toBe(true)
    const key = '/hello'
    const value = { data: 'world' }
    await masq2.put(key, value)
    const res = await masq2.get('/hello')
    expect(res).toEqual(value)

    // signout
    await masq2.signout()

    // fail to reconnect without logging in
    const masq3 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
    expect(masq3.isLoggedIn()).toBe(false)
    expect(masq3.isConnected()).toBe(false)
    await masq3.signout()
  })
  */

  test('should be able to put and get values after connect', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock()

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    const res = await masq.get('/hello')
    expect(res).toEqual(value)

    expect(masq.isLoggedIn()).toBe(true)
  })

  test('should be able to repeat login-disconnect-connect-signout', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    for (let i = 0; i < 5; i++) {
      await logInWithMasqAppMock()
      expect(masq.isLoggedIn()).toBe(true)
      expect(masq.isConnected()).toBe(true)

      const key = '/hello'
      const value = { data: 'world' }
      await masq.put(key, value)
      const res = await masq.get('/hello')
      expect(res).toEqual(value)

      await masq.disconnect()
      expect(masq.isLoggedIn()).toBe(true)
      expect(masq.isConnected()).toBe(false)

      try {
        await masq.put(key, value)
      } catch (err) {
        expect(err.message).toEqual('Not connected to Masq')
      }

      await masq.connectToMasq()
      expect(masq.isLoggedIn()).toBe(true)
      expect(masq.isConnected()).toBe(true)

      await masq.signout()
      expect(masq.isLoggedIn()).toBe(false)
      expect(masq.isConnected()).toBe(false)
    }
  })

  test('should fail when connect without prior login', async () => {
    expect.assertions(12)
    expect(masq.isLoggedIn()).toBe(false)

    try {
      await masq.connectToMasq()
    } catch (err) {
      expect(err.message).toBe('Not logged into Masq')
      expect(masq.isLoggedIn()).toBe(false)
      expect(masq.isConnected()).toBe(false)
    }

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should fail when connect after signout without prior login', async () => {
    expect.assertions(12)
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)

    try {
      await masq.connectToMasq()
    } catch (err) {
      expect(err.message).toBe('Not logged into Masq')
      expect(masq.isLoggedIn()).toBe(false)
      expect(masq.isConnected()).toBe(false)
    }
  })

  test('should be able to disconnect even if not logged in or connected', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should be able to disconnect more than once without error', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    try {
      await masq.connectToMasq()
    } catch (err) {
      expect(err.message).toBe('Not logged into Masq')
      expect(masq.isLoggedIn()).toBe(false)
      expect(masq.isConnected()).toBe(false)
    }

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should be able to connect more than once without error', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should be able to sign out more than once without error', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)
  })

  test('should be able to login more than once without error', async () => {
    expect(masq.isLoggedIn()).toBe(false)

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await logInWithMasqAppMock()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  })

  test('should be kicked if key is invalid', async () => {
    expect.assertions(2)

    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)
    const invalidKey = 'wrongChallenge'
    try {
      await Promise.all([
        mockMasqApp.handleConnectionAuthorized(hashParams.channel, invalidKey),
        masq.logIntoMasqDone()
      ])
    } catch (err) {
      expect(err).toBeDefined()
      expect(err.message).toBe('Invalid Key')
    }
  })

  test('should be kicked if wrong key is used', async () => {
    expect.assertions(2)

    try {
      const { link } = await masq.logIntoMasq()
      const url = new URL(link)
      const hashParams = getHashParams(url)
      // Extracted raw key is only a BUffer of bytes.
      let extractedWrongKey = Buffer.from(common.crypto.genRandomBuffer(16))
      await Promise.all([
        mockMasqApp.handleConnectionAuthorized(hashParams.channel, extractedWrongKey),
        masq.logIntoMasqDone()
      ])
    } catch (err) {
      expect(err).toBeDefined()
      expect(err.message).toBe('Unable to read the message with the key sent to Masq-app')
    }
  })

  test('should fail when register is refused', async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)
    await mockMasqApp.handleConnectionRegisterRefused(hashParams.channel, hashParams.key)
    expect.assertions(1)
    try {
      await masq.logIntoMasqDone()
    } catch (e) {
      expect(e.message).toBe('Masq access refused by the user')
    }
  })
})

// TODO add tests for unexpected message received
// TODO add tests for connect-disconnect-connect

describe('Test data access and input', () => {
  test('put/get should put and get an item', async () => {
    expect.assertions(1)
    await logInWithMasqAppMock()
    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    const res = await masq.get('/hello')
    expect(res).toEqual(value)
  })

  test('list should get every put items', async () => {
    expect.assertions(1)
    await logInWithMasqAppMock()
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
    const res = await masq.list()
    const expected = Object.keys(keyValues).reduce((dic, k) => {
      if (k !== 'hello2') dic[k] = keyValues[k]
      return dic
    }, {})
    expect(res).toEqual(expected)
  })

  test('del should del an item', async () => {
    expect.assertions(1)
    await logInWithMasqAppMock()
    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    await masq.del(key)
    const res = await masq.get('/hello')
    expect(res).toBeUndefined()
  })

  test('should set a watcher', async (done) => {
    expect.assertions(1)
    const onChange = () => {
      expect(true).toBe(true)
      done()
    }
    await logInWithMasqAppMock()
    const key = '/hello'
    const value = { data: 'world' }
    masq.watch('/hello', onChange)
    await masq.put(key, value)
  })

  test('should be able to get a notif on change in masq-app with a watcher on masq-lib', async () => {
    let resolvePrOnChangeMasqLib
    const prOnChangeMasqLib = new Promise((resolve) => { resolvePrOnChangeMasqLib = resolve })

    await logInWithMasqAppMock()
    const key = '/hello'
    const value = { data: 'world' }
    masq.watch('/hello', resolvePrOnChangeMasqLib)
    await mockMasqApp.put(masq.userId, key, value)

    await prOnChangeMasqLib
  })
})

describe('Test replication', () => {
  test('put/get should put an item and get in Mock Masq App', async () => {
    expect.assertions(1)
    await logInWithMasqAppMock()

    let resolvePrOnChangeMockMasqApp
    const prOnChangeMockMasqApp = new Promise((resolve) => { resolvePrOnChangeMockMasqApp = resolve })
    mockMasqApp.watch(masq.userId, '/hello', resolvePrOnChangeMockMasqApp)

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)

    await prOnChangeMockMasqApp
    const res = await mockMasqApp.get(masq.userId, '/hello')
    expect(res).toEqual(value)
  })
})
