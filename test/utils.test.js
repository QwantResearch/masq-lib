const utils = require('../src/utils')

window.indexedDB = require('fake-indexeddb')

test('DB should exist', async () => {
  expect.assertions(1)
  window.indexedDB.open('test1')
  const exists = await utils.dbExists('test1')
  expect(exists).toBe(true)
})

test('DB should not exist', async () => {
  expect.assertions(1)
  const exists = await utils.dbExists('test2')
  expect(exists).toBe(false)
})
