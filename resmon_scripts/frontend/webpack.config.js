const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Use webpack's built-in asset/resource generator, with no added plugin. Entry
// resources emit URL constants, never execute the inspected publisher modules.
const pdfRoot = path.join(__dirname, 'vendor/pdfjs/6.3.289');
const pdfAssets = [];
const collectPdfAssets = relative => {
  for (const item of fs.readdirSync(path.join(pdfRoot, relative), {withFileTypes:true})) {
    const name = path.posix.join(relative, item.name);
    if (item.isDirectory()) collectPdfAssets(name);
    else if (item.isFile()) pdfAssets.push(name);
    else throw new Error('Non-file in fixed PDF.js distribution');
  }
};
collectPdfAssets('');
if (pdfAssets.length !== 188) throw new Error('Expected exactly 188 fixed PDF.js publisher assets');
const pdfAssetNames = new Set(pdfAssets);

module.exports = {
  mode: 'development',
  entry: [...pdfAssets.map(name => path.join(pdfRoot, name)), './src/index.tsx'],
  target: 'electron-renderer',
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: 'bundle.js',
    publicPath: './',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  module: {
    rules: [
      {
        include: pdfRoot,
        type: 'asset/resource',
        generator: {
          filename: (data, info) => {
            const name = path.relative(pdfRoot, path.resolve(__dirname, data.filename)).split(path.sep).join('/');
            if (!pdfAssetNames.has(name)) throw new Error('Unexpected PDF.js asset path');
            // Preserve bytes through optimization. Only the two output suffixes
            // change to match the existing Electron server's JavaScript MIME.
            info.minimized = true;
            const output = name === 'build/pdf.min.mjs' ? 'build/pdf.min.js' : name === 'build/pdf.worker.min.mjs' ? 'build/pdf.worker.min.js' : name;
            return 'pdfjs/6.3.289/' + output;
          },
        },
      },
      {
        test: /src[\\/]lib[\\/]pdfjs\.ts$/,
        use: {loader:'ts-loader',options:{compilerOptions:{module:'esnext'}}},
      },
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: [/node_modules/, /src[\\/]lib[\\/]pdfjs\.ts$/],
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.(png|jpe?g|gif|webp|svg)$/i,
        type: 'asset/resource',
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/index.html',
    }),
  ],
  devtool: 'source-map',
};
