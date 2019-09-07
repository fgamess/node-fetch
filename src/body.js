
/**
 * Body.js
 *
 * Body interface provides common methods for Request and Response
 */

import Stream from 'stream';

import Blob, {BUFFER} from './blob';
import FetchError from './fetch-error';

let convert;
try {
	/* eslint-disable-next-line import/no-unresolved */
	convert = require('encoding').convert;
} catch (error) {}

const INTERNALS = Symbol('Body internals');

// Fix an issue where "PassThrough" isn't a named export for node <10
const {PassThrough} = Stream;

/**
 * Body mixin
 *
 * Ref: https://fetch.spec.whatwg.org/#body
 *
 * @param   Stream  body  Readable stream
 * @param   Object  opts  Response options
 * @return  Void
 */
export default function Body(body, {
	size = 0,
	timeout = 0
} = {}) {
	if (body == null) {
		// Body is undefined or null
		body = null;
	} else if (isURLSearchParams(body)) {
		// Body is a URLSearchParams
		body = Buffer.from(body.toString());
	} else if (isBlob(body)) {
		// Body is blob
	} else if (Buffer.isBuffer(body)) {
		// Body is Buffer
	} else if (Object.prototype.toString.call(body) === '[object ArrayBuffer]') {
		// Body is ArrayBuffer
		body = Buffer.from(body);
	} else if (ArrayBuffer.isView(body)) {
		// Body is ArrayBufferView
		body = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	} else if (body instanceof Stream) {
		// Body is stream
	} else {
		// None of the above
		// coerce to string then buffer
		body = Buffer.from(String(body));
	}

	this[INTERNALS] = {
		body,
		disturbed: false,
		error: null
	};
	this.size = size;
	this.timeout = timeout;

	if (body instanceof Stream) {
		body.on('error', err => {
			const error = err.name === 'AbortError' ?
				err :
				new FetchError(`Invalid response body while trying to fetch ${this.url}: ${err.message}`, 'system', err);
			this[INTERNALS].error = error;
		});
	}
}

Body.prototype = {
	get body() {
		return this[INTERNALS].body;
	},

	get bodyUsed() {
		return this[INTERNALS].disturbed;
	},

	/**
	 * Decode response as ArrayBuffer
	 *
	 * @return  Promise
	 */
	arrayBuffer() {
		return consumeBody.call(this).then(buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
	},

	/**
	 * Return raw response as Blob
	 *
	 * @return Promise
	 */
	blob() {
		const ct = this.headers && this.headers.get('content-type') || '';
		return consumeBody.call(this).then(buf => Object.assign(
			// Prevent copying
			new Blob([], {
				type: ct.toLowerCase()
			}),
			{
				[BUFFER]: buf
			}
		));
	},

	/**
	 * Decode response as json
	 *
	 * @return  Promise
	 */
	json() {
		return consumeBody.call(this).then(buffer => {
			try {
				return JSON.parse(buffer.toString());
			} catch (error) {
				return Body.Promise.reject(new FetchError(`invalid json response body at ${this.url} reason: ${error.message}`, 'invalid-json'));
			}
		});
	},

	/**
	 * Decode response as text
	 *
	 * @return  Promise
	 */
	text() {
		return consumeBody.call(this).then(buffer => buffer.toString());
	},

	/**
	 * Decode response as buffer (non-spec api)
	 *
	 * @return  Promise
	 */
	buffer() {
		return consumeBody.call(this);
	},

	/**
	 * Decode response as text, while automatically detecting the encoding and
	 * trying to decode to UTF-8 (non-spec api)
	 *
	 * @return  Promise
	 */
	textConverted() {
		return consumeBody.call(this).then(buffer => convertBody(buffer, this.headers));
	}
};

// In browsers, all properties are enumerable.
Object.defineProperties(Body.prototype, {
	body: {enumerable: true},
	bodyUsed: {enumerable: true},
	arrayBuffer: {enumerable: true},
	blob: {enumerable: true},
	json: {enumerable: true},
	text: {enumerable: true}
});

Body.mixIn = function (proto) {
	for (const name of Object.getOwnPropertyNames(Body.prototype)) {
		// istanbul ignore else: future proof
		if (!(name in proto)) {
			const desc = Object.getOwnPropertyDescriptor(Body.prototype, name);
			Object.defineProperty(proto, name, desc);
		}
	}
};

/**
 * Consume and convert an entire Body to a Buffer.
 *
 * Ref: https://fetch.spec.whatwg.org/#concept-body-consume-body
 *
 * @return  Promise
 */
function consumeBody() {
	if (this[INTERNALS].disturbed) {
		return Body.Promise.reject(new TypeError(`body used already for: ${this.url}`));
	}

	this[INTERNALS].disturbed = true;

	if (this[INTERNALS].error) {
		return Body.Promise.reject(this[INTERNALS].error);
	}

	let {body} = this;

	// Body is null
	if (body === null) {
		return Body.Promise.resolve(Buffer.alloc(0));
	}

	// Body is blob
	if (isBlob(body)) {
		body = body.stream();
	}

	// Body is buffer
	if (Buffer.isBuffer(body)) {
		return Body.Promise.resolve(body);
	}

	// istanbul ignore if: should never happen
	if (!(body instanceof Stream)) {
		return Body.Promise.resolve(Buffer.alloc(0));
	}

	// Body is stream
	// get ready to actually consume the body
	const accum = [];
	let accumBytes = 0;
	let abort = false;

	return new Body.Promise((resolve, reject) => {
		let resTimeout;

		// Allow timeout on slow response body
		if (this.timeout) {
			resTimeout = setTimeout(() => {
				abort = true;
				reject(new FetchError(`Response timeout while trying to fetch ${this.url} (over ${this.timeout}ms)`, 'body-timeout'));
			}, this.timeout);
		}

		// Handle stream errors
		body.on('error', err => {
			if (err.name === 'AbortError') {
				// If the request was aborted, reject with this Error
				abort = true;
				reject(err);
			} else {
				// Other errors, such as incorrect content-encoding
				reject(new FetchError(`Invalid response body while trying to fetch ${this.url}: ${err.message}`, 'system', err));
			}
		});

		body.on('data', chunk => {
			if (abort || chunk === null) {
				return;
			}

			if (this.size && accumBytes + chunk.length > this.size) {
				abort = true;
				reject(new FetchError(`content size at ${this.url} over limit: ${this.size}`, 'max-size'));
				return;
			}

			accumBytes += chunk.length;
			accum.push(chunk);
		});

		body.on('end', () => {
			if (abort) {
				return;
			}

			clearTimeout(resTimeout);

			try {
				resolve(Buffer.concat(accum, accumBytes));
			} catch (error) {
				// Handle streams that have accumulated too much data (issue #414)
				reject(new FetchError(`Could not create Buffer from response body for ${this.url}: ${error.message}`, 'system', error));
			}
		});
	});
}

/**
 * Detect buffer encoding and convert to target encoding
 * ref: http://www.w3.org/TR/2011/WD-html5-20110113/parsing.html#determining-the-character-encoding
 *
 * @param   Buffer  buffer    Incoming buffer
 * @param   String  encoding  Target encoding
 * @return  String
 */
function convertBody(buffer, headers) {
	if (typeof convert !== 'function') {
		throw new TypeError('The package `encoding` must be installed to use the textConverted() function');
	}

	const ct = headers.get('content-type');
	let charset = 'utf-8';
	let res;
	let str;

	// Header
	if (ct) {
		res = /charset=([^;]*)/i.exec(ct);
	}

	// No charset in content type, peek at response body for at most 1024 bytes
	/* eslint-disable-next-line prefer-const */
	str = buffer.slice(0, 1024).toString();

	// Html5
	if (!res && str) {
		res = /<meta.+?charset=(['"])(.+?)\1/i.exec(str);
	}

	// Html4
	if (!res && str) {
		res = /<meta[\s]+?http-equiv=(['"])content-type\1[\s]+?content=(['"])(.+?)\2/i.exec(str);

		if (res) {
			res = /charset=(.*)/i.exec(res.pop());
		}
	}

	// Xml
	if (!res && str) {
		res = /<\?xml.+?encoding=(['"])(.+?)\1/i.exec(str);
	}

	// Found charset
	if (res) {
		charset = res.pop();

		// Prevent decode issues when sites use incorrect encoding
		// ref: https://hsivonen.fi/encoding-menu/
		if (charset === 'gb2312' || charset === 'gbk') {
			charset = 'gb18030';
		}
	}

	// Turn raw buffers into a single utf-8 buffer
	return convert(
		buffer,
		'UTF-8',
		charset
	).toString();
}

/**
 * Detect a URLSearchParams object
 * ref: https://github.com/bitinn/node-fetch/issues/296#issuecomment-307598143
 *
 * @param   Object  obj     Object to detect by type or brand
 * @return  String
 */
function isURLSearchParams(obj) {
	// Duck-typing as a necessary condition.
	if (typeof obj !== 'object' ||
		typeof obj.append !== 'function' ||
		typeof obj.delete !== 'function' ||
		typeof obj.get !== 'function' ||
		typeof obj.getAll !== 'function' ||
		typeof obj.has !== 'function' ||
		typeof obj.set !== 'function') {
		return false;
	}

	// Brand-checking and more duck-typing as optional condition.
	return obj.constructor.name === 'URLSearchParams' ||
		Object.prototype.toString.call(obj) === '[object URLSearchParams]' ||
		typeof obj.sort === 'function';
}

/**
 * Check if `obj` is a W3C `Blob` object (which `File` inherits from)
 * @param  {*} obj
 * @return {boolean}
 */
function isBlob(obj) {
	return typeof obj === 'object' &&
				typeof obj.arrayBuffer === 'function' &&
				typeof obj.type === 'string' &&
				typeof obj.stream === 'function' &&
				typeof obj.constructor === 'function' &&
				typeof obj.constructor.name === 'string' &&
				/^(Blob|File)$/.test(obj.constructor.name) &&
				/^(Blob|File)$/.test(obj[Symbol.toStringTag]);
}

/**
 * Clone body given Res/Req instance
 *
 * @param   Mixed  instance  Response or Request instance
 * @return  Mixed
 */
export function clone(instance) {
	let p1;
	let p2;
	let {body} = instance;

	// Don't allow cloning a used body
	if (instance.bodyUsed) {
		throw new Error('cannot clone body after it is used');
	}

	// Check that body is a stream and not form-data object
	// note: we can't clone the form-data object without having it as a dependency
	if ((body instanceof Stream) && (typeof body.getBoundary !== 'function')) {
		// Tee instance body
		p1 = new PassThrough();
		p2 = new PassThrough();
		body.pipe(p1);
		body.pipe(p2);
		// Set instance body to teed body and return the other teed body
		instance[INTERNALS].body = p1;
		body = p2;
	}

	return body;
}

/**
 * Performs the operation "extract a `Content-Type` value from |object|" as
 * specified in the specification:
 * https://fetch.spec.whatwg.org/#concept-bodyinit-extract
 *
 * This function assumes that instance.body is present.
 *
 * @param   Mixed  instance  Any options.body input
 */
export function extractContentType(body) {
	if (body === null) {
		// Body is null
		return null;
	}

	if (typeof body === 'string') {
		// Body is string
		return 'text/plain;charset=UTF-8';
	}

	if (isURLSearchParams(body)) {
		// Body is a URLSearchParams
		return 'application/x-www-form-urlencoded;charset=UTF-8';
	}

	if (isBlob(body)) {
		// Body is blob
		return body.type || null;
	}

	if (Buffer.isBuffer(body)) {
		// Body is buffer
		return null;
	}

	if (Object.prototype.toString.call(body) === '[object ArrayBuffer]') {
		// Body is ArrayBuffer
		return null;
	}

	if (ArrayBuffer.isView(body)) {
		// Body is ArrayBufferView
		return null;
	}

	if (typeof body.getBoundary === 'function') {
		// Detect form data input from form-data module
		return `multipart/form-data;boundary=${body.getBoundary()}`;
	}

	if (body instanceof Stream) {
		// Body is stream
		// can't really do much about this
		return null;
	}

	// Body constructor defaults other things to string
	return 'text/plain;charset=UTF-8';
}

/**
 * The Fetch Standard treats this as if "total bytes" is a property on the body.
 * For us, we have to explicitly get it with a function.
 *
 * ref: https://fetch.spec.whatwg.org/#concept-body-total-bytes
 *
 * @param   Body    instance   Instance of Body
 * @return  Number?            Number of bytes, or null if not possible
 */
export function getTotalBytes(instance) {
	const {body} = instance;

	if (body === null) {
		// Body is null
		return 0;
	}

	if (isBlob(body)) {
		return body.size;
	}

	if (Buffer.isBuffer(body)) {
		// Body is buffer
		return body.length;
	}

	if (body && typeof body.getLengthSync === 'function') {
		// Detect form data input from form-data module
		if (body._lengthRetrievers && body._lengthRetrievers.length == 0 || // 1.x
			body.hasKnownLength && body.hasKnownLength()) { // 2.x
			return body.getLengthSync();
		}

		return null;
	}

	// Body is stream
	return null;
}

/**
 * Write a Body to a Node.js WritableStream (e.g. http.Request) object.
 *
 * @param   Body    instance   Instance of Body
 * @return  Void
 */
export function writeToStream(dest, instance) {
	const {body} = instance;

	if (body === null) {
		// Body is null
		dest.end();
	} else if (isBlob(body)) {
		body.stream().pipe(dest);
	} else if (Buffer.isBuffer(body)) {
		// Body is buffer
		dest.write(body);
		dest.end();
	} else {
		// Body is stream
		body.pipe(dest);
	}
}

// Expose Promise
Body.Promise = global.Promise;
