import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, normalizePlatforms } from '../src/core.mjs';
test('平台选项跨备份保留，去除空白和大小写重复，保留地区区别', () => {
 const names = [' Shopee ', 'shopee', '新加坡Shopee', '', '拼多多'];
 assert.deepEqual(normalizePlatforms(names), ['Shopee','新加坡Shopee','拼多多']);
 const state = normalizeState({settings:{platforms:names}});
 assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))).settings.platforms, state.settings.platforms);
});
