"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compress = compress;
exports.decompress = decompress;
// targz for Backup and Restore
const node_fs_1 = require("node:fs");
const node_zlib_1 = require("node:zlib");
const tar_fs_1 = require("tar-fs");
function compress(opts, callback) {
    const cb = callback || (() => { });
    // Note: a failure in any of the three streams reports through here. As in the original
    // implementation the callback is not guarded against firing more than once.
    const error = (err) => cb(err);
    opts = opts || {};
    opts.tar = opts.tar || {};
    opts.gz = opts.gz || {};
    // default gzip config
    opts.gz.level = opts.gz.level || 6;
    opts.gz.memLevel = opts.gz.memLevel || 6;
    // ensure src and dest
    if (!opts.src) {
        return error(`BackItUp cannot found source "${opts.src}" for compress!`);
    }
    if (!opts.dest) {
        return error(`BackItUp cannot found destination "${opts.dest}" for compress!`);
    }
    const src = opts.src;
    const dest = opts.dest;
    const tarOpts = opts.tar;
    const gzOpts = opts.gz;
    // compress
    process.nextTick(() => {
        (0, tar_fs_1.pack)(src, tarOpts)
            .on('error', error)
            .pipe((0, node_zlib_1.createGzip)(gzOpts).on('error', error))
            .pipe((0, node_fs_1.createWriteStream)(dest).on('error', error).on('finish', () => cb()));
    });
}
function decompress(opts, callback) {
    const cb = callback || (() => { });
    const error = (err) => cb(err);
    opts = opts || {};
    opts.tar = opts.tar || {};
    opts.gz = opts.gz || {};
    // ensure src and dest
    if (!opts.src) {
        return error(`BackItUp cannot found source "${opts.src}" for decompress!`);
    }
    if (!opts.dest) {
        return error(`BackItUp cannot found destination "${opts.dest}" for decompress!`);
    }
    const src = opts.src;
    const dest = opts.dest;
    const tarOpts = opts.tar;
    const gzOpts = opts.gz;
    // decompress
    process.nextTick(() => {
        (0, node_fs_1.createReadStream)(src)
            .on('error', error)
            .pipe((0, node_zlib_1.createGunzip)(gzOpts).on('error', error))
            .pipe((0, tar_fs_1.extract)(dest, tarOpts).on('error', error).on('finish', () => cb()));
    });
}
//# sourceMappingURL=targz.js.map