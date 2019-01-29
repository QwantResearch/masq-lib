var path = require('path')

module.exports = {
  entry: './babelOut/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'masq.js',
    library: 'masq'
  }
}
