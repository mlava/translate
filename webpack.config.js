module.exports = {
    entry: './src/index.js',
    output: {
        filename: 'extension.js',
        path: __dirname,
        library: {
            type: "module",
        }
    },
	target: ['electron-renderer'],
    experiments: {
        outputModule: true,
    },
	resolve: {
        fallback: {
            "fs": false
        },
    }
};