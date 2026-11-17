const assert = require('assert');
const crypto = require('crypto');
const { generateSign } = require('../src/services/xhsClient');

// 对照官方文档 Python 示例
function refSign(appId, timestamp, method, appSecret) {
  const params = [`appId=${appId}`, `timestamp=${timestamp}`, 'version=2.0'].sort();
  const source = `${method}?${params.join('&')}${appSecret}`;
  return crypto.createHash('md5').update(source, 'utf8').digest('hex');
}

const appId = '21d6abcd748be8de0';
const timestamp = '1612518379';
const method = 'product.createItem';
const appSecret = '429aabcd3aee9ef9e4a858210';

const sign = generateSign(appId, timestamp, method, appSecret);
assert.strictEqual(sign, refSign(appId, timestamp, method, appSecret), '签名算法与官方示例一致');
console.log('sign =', sign);
console.log('签名算法校验通过 ✓');
