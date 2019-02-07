var path = require('path')

module.exports = {
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'masq.js',
    library: 'masq',
    libraryTarget: 'umd'
  },
  node: {
    fs: 'empty'
  },
  externals: {
    'masq-common': 'commonjs masq-common'
  }
}
