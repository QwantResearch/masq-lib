module.exports.dBExists = function (dbName) {
  return new Promise((resolve, reject) => {
    let req = global.indexedDB.open(dbName, false)
    let existed = true
    req.onsuccess = () => {
      req.result.close()
      if (!existed) { global.indexedDB.deleteDatabase(dbName) }
      resolve(existed)
    }
    req.onupgradeneeded = () => {
      existed = false
    }
  })
}
