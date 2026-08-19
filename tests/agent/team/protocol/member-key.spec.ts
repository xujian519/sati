/**
 * 成员会话 key：构造/解析纯函数。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMBER_SESSION_PREFIX,
  memberSessionKey,
  parseMemberSessionKey,
} from "../../../../src/agent/team/protocol/member-key.js";

test("构造：team:<teamId>:<memberId> 格式", () => {
  assert.equal(memberSessionKey("t1", "m1"), "team:t1:m1");
  assert.equal(memberSessionKey("专利组", "检索员"), "team:专利组:检索员");
});

test("解析：合法 key 往返", () => {
  assert.deepEqual(parseMemberSessionKey("team:t1:m1"), { teamId: "t1", memberId: "m1" });
  // memberId 本身含冒号时按第一个冒号切分
  assert.deepEqual(parseMemberSessionKey("team:a:b:m1"), { teamId: "a", memberId: "b:m1" });
});

test("解析：非成员 key 返回 null", () => {
  assert.equal(parseMemberSessionKey("web:abc"), null);
  assert.equal(parseMemberSessionKey("always-on-discovery:x"), null);
  assert.equal(parseMemberSessionKey(""), null);
  assert.equal(parseMemberSessionKey("team:"), null);
  assert.equal(parseMemberSessionKey("team:m1"), null); // 缺 teamId 分隔符
});

test("前缀常量：非空且被解析器依赖", () => {
  assert.ok(MEMBER_SESSION_PREFIX.length > 0);
  assert.ok(parseMemberSessionKey(`${MEMBER_SESSION_PREFIX}x:y`) !== null);
});
