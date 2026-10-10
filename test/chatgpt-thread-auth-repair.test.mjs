import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForTargetContent } from '../dist/chatgpt-thread-lib.mjs';

const threadUrl = 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';

test('signed-out page fails fast before expensive thread export', async () => {
  const client = {
    evaluate: async () => ({
      href: 'https://chatgpt.com/',
      readyState: 'complete',
      title: 'ChatGPT: Chat, Work, Create & Code with AI',
      bodyLength: 637,
      articleCount: 0,
      messageCount: 0,
      attachmentButtonCount: 0,
      loginRequired: true,
    }),
  };
  await assert.rejects(waitForTargetContent(client, threadUrl, 30), /Log in required/);
});

test('challenge fails closed and is not misclassified as an empty thread', async () => {
  const client = { evaluate: async () => ({
    href: threadUrl,
    readyState: 'complete',
    title: 'Just a moment...',
    bodyLength: 120,
    articleCount: 0,
    messageCount: 0,
    attachmentButtonCount: 0,
    authChallenge: true,
  }) };
  await assert.rejects(waitForTargetContent(client, threadUrl, 30), /Cloudflare challenge/);
});

test('authenticated existing conversation remains eligible for snapshot', async () => {
  const client = { evaluate: async () => ({
    href: threadUrl,
    readyState: 'complete',
    title: 'Conversation',
    bodyLength: 2000,
    articleCount: 2,
    messageCount: 2,
    attachmentButtonCount: 0,
    loginRequired: false,
    authChallenge: false,
  }) };
  const result = await waitForTargetContent(client, threadUrl, 30);
  assert.equal(result.messageCount, 2);
});
