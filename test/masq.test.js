const Masq = require('../src/index')

// user an in memory random-access-storage instead
jest.mock('random-access-idb', () =>
  () => require('random-access-memory'))

let masq = null

test('initialize', async () => {
  masq = new Masq()
  await masq.init()
})

test('should get empty profiles', async () => {
  let profiles = await masq.getProfiles()
  expect(profiles).toEqual([])
})
