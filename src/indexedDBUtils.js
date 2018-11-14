module.exports.dBExists = function (dbName) {
  return new Promise((resolve, reject) => {
    let req = indexedDB.open(dbName, false)
    let existed = true
    req.onsuccess = () => {
      req.result.close()
      if (!existed) { indexedDB.deleteDatabase(dbName) }
      resolve(existed)
    }
    req.onupgradeneeded = () => {
      existed = false
    }
  })
}