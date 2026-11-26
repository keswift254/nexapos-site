/*
 * Support in the Lite core: the apps' Support conversations, over the shop's own support endpoints. A pretend shop server
 * records exactly what the till sends (method, address, body, the device key) and answers as the real one does.
 *
 * Run: node tests/lite/support.test.js
 */
'use strict';

process.env.TZ = 'Africa/Nairobi';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var OWNER = '33333333-3333-4333-8333-333333333333';
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function fakeStorage() {
  var data = {};
  return {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-16T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [], products: [],
    users: [{ id: OWNER, roleId: '00000000-0000-4000-8000-000000000001', name: 'Owner', username: 'owner', passwordHash: fixtures[0].hash, status: 'active' }],
    roles: []
  };
}

/** A joined till. `answer(request)` returns {status, body} (or 'offline') for the support calls; every request is kept in `sent`. */
function till(answer, done) {
  var sent = [];
  var http = function (request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var result;
    if (action === 'register_device') { result = { status: 201, body: { success: true, api_key: 'key-1' } }; }
    else if (action === 'join_shop') { result = { status: 200, body: { success: true } }; }
    else if (action === 'lite_catalog') { result = { status: 200, body: catalogBody() }; }
    else {
      sent.push({ method: request.method, url: request.url, body: request.body ? JSON.parse(request.body) : null, auth: request.headers.Authorization });
      result = answer({ method: request.method, url: request.url, action: action, body: request.body ? JSON.parse(request.body) : null });
    }
    setImmediate(function () {
      if (result === 'offline') { cb(new Error('network')); return; }
      cb(null, { status: result.status, text: typeof result.body === 'string' ? result.body : JSON.stringify(result.body) });
    });
  };
  var core = Core.create({ baseUrl: BASE, http: http, storage: fakeStorage(), bcrypt: bcrypt, sale: Sale, now: function () { return 1000; }, randomHex: Core.randomHex });
  core.join('INV', 'Till', function (error) { assert.ifError(error); done({ core: core, sent: sent }); });
}
function untilJoined(done) {
  var core = Core.create({ baseUrl: BASE, http: function (r, cb) { setImmediate(function () { cb(new Error('network')); }); }, storage: fakeStorage(), bcrypt: bcrypt, sale: Sale, now: function () { return 1000; }, randomHex: Core.randomHex });
  done(core);
}

// ---- the tickets ---------------------------------------------------------------------------------------------------------------------
test('the list is asked for with the device key and read into plain tickets; replies waiting are counted', function (done) {
  till(function () {
    return { status: 200, body: { success: true, tickets: [
      { id: '12', subject: 'Printer', customer_email: 'a@b.co', status: 'pending', created_at: '2026-11-16 08:00:00', updated_at: '2026-11-16 09:00:00', last_support_message_id: 5 },
      { id: 9, subject: 'Old one', customer_email: null, status: 'closed', created_at: '2026-11-01 08:00:00', updated_at: '2026-11-02 08:00:00' },
      { id: 4, subject: 'Waiting', customer_email: 'a@b.co', status: 'open', created_at: '', updated_at: '' },
      { id: 5, subject: 'Odd', status: 'weird' },
      { id: 'x', subject: 'no id' }
    ] } };
  }, function (t) {
    assert.strictEqual(t.core.supportRepliesWaiting(), 0);
    t.core.supportList(function (error, tickets) {
      assert.ifError(error);
      assert.strictEqual(t.sent[0].method, 'GET');
      assert.ok(/action=support_list$/.test(t.sent[0].url));
      assert.strictEqual(t.sent[0].auth, 'Bearer key-1');
      assert.deepStrictEqual(tickets.map(function (x) { return x.id + ':' + x.status; }), ['9:closed', '4:open', '5:open'], 'an unknown status reads as open');
      done();
    });
  });
});

test('ticket ids that are numbers are read, strings are not trusted (the server sends numbers)', function (done) {
  till(function () {
    return { status: 200, body: { success: true, tickets: [{ id: 12, subject: 'Printer', customer_email: 'a@b.co', status: 'pending', created_at: '2026-11-16 08:00:00', updated_at: '2026-11-16 09:00:00' }, { id: '13', subject: 'x', status: 'open' }] } };
  }, function (t) {
    t.core.supportList(function (error, tickets) {
      assert.ifError(error);
      assert.deepStrictEqual(tickets, [{ id: 12, subject: 'Printer', status: 'pending', email: 'a@b.co', createdAt: '2026-11-16 08:00:00', updatedAt: '2026-11-16 09:00:00', lastMessageId: 0 }]);
      assert.strictEqual(t.core.supportRepliesWaiting(), 1, 'one reply from support is waiting');
      done();
    });
  });
});

test('the newest support message of a ticket is kept (the server may send it as text), so a reply can be told apart from the last one', function (done) {
  till(function () {
    return { status: 200, body: { success: true, tickets: [
      { id: 12, subject: 'A', status: 'pending', last_support_message_id: '17' },
      { id: 13, subject: 'B', status: 'open', last_support_message_id: null },
      { id: 14, subject: 'C', status: 'open', last_support_message_id: 'x' },
      { id: 15, subject: 'D', status: 'open', last_support_message_id: 4.5 }
    ] } };
  }, function (t) {
    t.core.supportList(function (error, tickets) {
      assert.ifError(error);
      assert.deepStrictEqual(tickets.map(function (x) { return x.lastMessageId; }), [17, 0, 0, 0]);
      done();
    });
  });
});

test('list problems are said in plain words: not allowed, an answer that cannot be read, no internet, an old server, not joined', function (done) {
  var mode = 'forbidden';
  till(function () {
    if (mode === 'forbidden') { return { status: 403, body: { success: false, message: 'This device has been disabled.' } }; }
    if (mode === 'unauthorized') { return { status: 401, body: { status: false, message: 'Invalid or missing API key.' } }; }
    if (mode === 'junk') { return { status: 200, body: { success: true, tickets: 'many' } }; }
    if (mode === 'old') { return { status: 404, body: { success: false, message: 'Unknown action.' } }; }
    return 'offline';
  }, function (t) {
    t.core.supportList(function (e1) {
      assert.strictEqual(e1.code, 'forbidden');
      assert.ok(/not allowed to use support/.test(e1.message));
      mode = 'unauthorized';
      t.core.supportList(function (e2) {
        assert.strictEqual(e2.code, 'unauthorized');
        mode = 'junk';
        t.core.supportList(function (e3) {
          assert.strictEqual(e3.code, 'server');
          assert.ok(/cannot read/.test(e3.message));
          mode = 'old';
          t.core.supportList(function (e4) {
            assert.strictEqual(e4.code, 'unavailable');
            mode = 'offline';
            t.core.supportList(function (e5) {
              assert.strictEqual(e5.code, 'offline');
              untilJoined(function (notJoined) {
                notJoined.supportList(function (e6) {
                  assert.strictEqual(e6.code, 'input');
                  assert.ok(/not joined a shop/.test(e6.message));
                  done();
                });
              });
            });
          });
        });
      });
    });
  });
});

// ---- opening a ticket ------------------------------------------------------------------------------------------------------------------
test('a ticket is opened with the subject, the words, the email and the photos, trimmed, and the new number comes back', function (done) {
  till(function () { return { status: 201, body: { success: true, ticket_id: 31 } }; }, function (t) {
    t.core.supportOpen({ subject: '  Receipt printer  ', message: '  It prints blank.  ', email: ' me@shop.co ', photos: ['QUJD', 'REVG'] }, function (error, id) {
      assert.ifError(error);
      assert.strictEqual(id, 31);
      assert.strictEqual(t.sent[0].method, 'POST');
      assert.ok(/action=support_open$/.test(t.sent[0].url));
      assert.deepStrictEqual(t.sent[0].body, { subject: 'Receipt printer', message: 'It prints blank.', email: 'me@shop.co', attachments: [{ data: 'QUJD' }, { data: 'REVG' }] });
      done();
    });
  });
});

test('a ticket that is not complete is refused before anything is sent, in the server\'s words', function (done) {
  till(function () { return { status: 201, body: { success: true, ticket_id: 1 } }; }, function (t) {
    function refused(request, message, then) {
      t.core.supportOpen(request, function (error) {
        assert.ok(error, message);
        assert.strictEqual(error.code, 'input');
        assert.strictEqual(error.message, message);
        then();
      });
    }
    var ok = { subject: 'Printer', message: 'Blank', email: 'a@b.co', photos: [] };
    function with_(extra) { var r = {}; for (var k in ok) { r[k] = ok[k]; } for (var j in extra) { r[j] = extra[j]; } return r; }
    refused(with_({ subject: 'ab' }), 'Subject must be between 3 and 160 characters.', function () {
      refused(with_({ subject: new Array(162).join('x') }), 'Subject must be between 3 and 160 characters.', function () {
        refused(with_({ message: '   ' }), 'Describe the issue in 1 to 8000 characters.', function () {
          refused(with_({ message: new Array(8002).join('x') }), 'Describe the issue in 1 to 8000 characters.', function () {
            refused(with_({ email: 'not an email' }), 'Enter a valid email address, so we can send you a copy of every reply.', function () {
              refused(with_({ email: '' }), 'Enter a valid email address, so we can send you a copy of every reply.', function () {
                refused(with_({ photos: ['a', 'b', 'c', 'd', 'e'] }), 'Attach up to 4 photos per message.', function () {
                  assert.strictEqual(t.sent.length, 0, 'nothing was sent');
                  done();
                });
              });
            });
          });
        });
      });
    });
  });
});

test('a ticket with only photos is fine; the longest message and subject allowed are fine', function (done) {
  till(function () { return { status: 201, body: { success: true, ticket_id: 2 } }; }, function (t) {
    t.core.supportOpen({ subject: 'abc', message: '', email: 'a@b.co', photos: ['QUJD'] }, function (e1) {
      assert.ifError(e1);
      t.core.supportOpen({ subject: new Array(161).join('s'), message: new Array(8001).join('m'), email: 'a@b.co' }, function (e2) {
        assert.ifError(e2);
        done();
      });
    });
  });
});

test('the server\'s own refusal (a bad photo, the 20 MB limit) is shown as it is; an answer without a number is not taken for success', function (done) {
  var mode = 'photo';
  till(function () {
    if (mode === 'photo') { return { status: 422, body: { success: false, message: 'Each photo must be 2 MB or smaller.' } }; }
    return { status: 201, body: { success: true } };
  }, function (t) {
    t.core.supportOpen({ subject: 'Printer', message: 'x', email: 'a@b.co', photos: ['QUJD'] }, function (e1) {
      assert.strictEqual(e1.message, 'Each photo must be 2 MB or smaller.');
      mode = 'nonumber';
      t.core.supportOpen({ subject: 'Printer', message: 'x', email: 'a@b.co' }, function (e2) {
        assert.strictEqual(e2.code, 'server');
        assert.ok(/did not confirm the ticket/.test(e2.message));
        done();
      });
    });
  });
});

// ---- a conversation -----------------------------------------------------------------------------------------------------------------------
test('a conversation is read: messages oldest first, who wrote them, the message each quotes, reactions and photos', function (done) {
  till(function () {
    return { status: 200, body: { success: true, ticket: { id: 12, subject: 'Printer', customer_email: 'a@b.co', status: 'pending', created_at: '2026-11-16 08:00:00', updated_at: '2026-11-16 09:00:00' },
      messages: [
        { id: 1, sender: 'customer', body: 'It prints blank.', reply_to_id: null, created_at: '2026-11-16 08:00:00', reply_to: null, reactions: [], attachments: [{ id: 70, mime_type: 'image/jpeg', byte_size: 1000 }] },
        { id: 2, sender: 'support', body: 'Is it a thermal printer?', reply_to_id: 1, created_at: '2026-11-16 08:30:00', reply_to: { id: 1, sender: 'customer', snippet: 'It prints blank.' }, reactions: [{ sender: 'customer', emoji: '👍' }, { sender: 'support', emoji: '❤️' }], attachments: [] },
        { id: 'bad', sender: 'support', body: 'ignored' },
        { id: 3, sender: 'something else', body: null, created_at: null, reactions: 'no', attachments: [{ id: 'x' }] }
      ] } };
  }, function (t) {
    t.core.supportThread(12, function (error, thread) {
      assert.ifError(error);
      assert.ok(/action=support_thread&ticket_id=12$/.test(t.sent[0].url));
      assert.strictEqual(thread.ticket.subject, 'Printer');
      assert.deepStrictEqual(thread.messages.map(function (m) { return m.id; }), [1, 2, 3], 'a message with no usable id is left out');
      assert.deepStrictEqual(thread.messages[0].attachments, [{ id: 70, mime: 'image/jpeg' }]);
      assert.strictEqual(thread.messages[1].sender, 'support');
      assert.deepStrictEqual(thread.messages[1].replyTo, { id: 1, sender: 'customer', snippet: 'It prints blank.' });
      assert.deepStrictEqual(thread.messages[1].reactions, [{ sender: 'customer', emoji: '👍' }, { sender: 'support', emoji: '❤️' }]);
      assert.strictEqual(thread.messages[2].sender, 'customer', 'anything but support is the shop');
      assert.strictEqual(thread.messages[2].body, '');
      assert.deepStrictEqual(thread.messages[2].reactions, []);
      assert.deepStrictEqual(thread.messages[2].attachments, []);
      done();
    });
  });
});

test('a conversation that is not this shop\'s, or cannot be read, says so', function (done) {
  var mode = 'missing';
  till(function () {
    if (mode === 'missing') { return { status: 404, body: { success: false, message: 'Support ticket not found.' } }; }
    return { status: 200, body: { success: true, ticket: null, messages: [] } };
  }, function (t) {
    t.core.supportThread(99, function (e1) {
      assert.strictEqual(e1.message, 'Support ticket not found.');
      mode = 'junk';
      t.core.supportThread(99, function (e2) {
        assert.strictEqual(e2.code, 'server');
        done();
      });
    });
  });
});

// ---- replying, reading, reacting, closing -----------------------------------------------------------------------------------------------
test('a reply carries the ticket, the words, the photos and (only when there is one) the message it answers', function (done) {
  var ids = [5, 6];
  till(function () { return { status: 200, body: { success: true, message_id: ids.shift() } }; }, function (t) {
    t.core.supportReply({ ticketId: 12, message: '  Thank you  ', photos: [], replyToId: 2 }, function (e1, id1) {
      assert.ifError(e1);
      assert.strictEqual(id1, 5);
      assert.deepStrictEqual(t.sent[0].body, { ticket_id: 12, message: 'Thank you', attachments: [], reply_to_id: 2 });
      t.core.supportReply({ ticketId: 12, message: '', photos: ['QUJD'] }, function (e2, id2) {
        assert.ifError(e2);
        assert.strictEqual(id2, 6);
        assert.deepStrictEqual(t.sent[1].body, { ticket_id: 12, message: '', attachments: [{ data: 'QUJD' }] }, 'no reply_to_id key when nothing is quoted');
        assert.ok(/action=support_reply$/.test(t.sent[1].url));
        ids.push(7);
        t.core.supportReply({ ticketId: 12, message: 'x', photos: [], replyToId: null }, function (e3) {
          assert.ifError(e3);
          assert.deepStrictEqual(t.sent[2].body, { ticket_id: 12, message: 'x', attachments: [] }, 'a null quote is not sent either');
          done();
        });
      });
    });
  });
});

test('an empty reply, too long a reply and too many photos are refused before anything is sent', function (done) {
  till(function () { return { status: 200, body: { success: true, message_id: 1 } }; }, function (t) {
    t.core.supportReply({ ticketId: 1, message: '  ', photos: [] }, function (e1) {
      assert.strictEqual(e1.message, 'Message must be between 1 and 8000 characters.');
      t.core.supportReply({ ticketId: 1, message: new Array(8002).join('x'), photos: [] }, function (e2) {
        assert.strictEqual(e2.message, 'Message must be between 1 and 8000 characters.');
        t.core.supportReply({ ticketId: 1, message: 'hi', photos: ['1', '2', '3', '4', '5'] }, function (e3) {
          assert.strictEqual(e3.message, 'Attach up to 4 photos per message.');
          assert.strictEqual(t.sent.length, 0);
          done();
        });
      });
    });
  });
});

test('a reply that cannot be sent keeps its reason (offline, the server\'s refusal) so the page can offer to try again', function (done) {
  var mode = 'offline';
  till(function () { return mode === 'offline' ? 'offline' : { status: 422, body: { success: false, message: 'The message you are replying to is not in this conversation.' } }; }, function (t) {
    t.core.supportReply({ ticketId: 1, message: 'hi', photos: [] }, function (e1) {
      assert.strictEqual(e1.code, 'offline');
      mode = 'refused';
      t.core.supportReply({ ticketId: 1, message: 'hi', photos: [], replyToId: 99 }, function (e2) {
        assert.strictEqual(e2.message, 'The message you are replying to is not in this conversation.');
        done();
      });
    });
  });
});

test('reading replies is reported up to the newest one; a failure is quiet', function (done) {
  var mode = 'fine';
  till(function () { return mode === 'fine' ? { status: 200, body: { success: true, marked: 2 } } : { status: 500, body: { success: false, message: 'boom' } }; }, function (t) {
    t.core.supportMarkRead(12, 9, function (e1) {
      assert.strictEqual(e1, null);
      assert.deepStrictEqual(t.sent[0].body, { ticket_id: 12, through_message_id: 9 });
      assert.ok(/action=support_mark_read$/.test(t.sent[0].url));
      mode = 'broken';
      t.core.supportMarkRead(12, 10, function (e2) {
        assert.ok(e2, 'the caller may try again later');
        t.core.supportMarkRead(12, 11);
        setImmediate(done);
      });
    });
  });
});

test('a reaction is sent, and taking it off sends nothing as the emoji', function (done) {
  till(function () { return { status: 200, body: { success: true } }; }, function (t) {
    t.core.supportReact(12, 2, '👍', function (e1) {
      assert.ifError(e1);
      assert.deepStrictEqual(t.sent[0].body, { ticket_id: 12, message_id: 2, emoji: '👍' });
      t.core.supportReact(12, 2, null, function (e2) {
        assert.ifError(e2);
        assert.deepStrictEqual(t.sent[1].body, { ticket_id: 12, message_id: 2, emoji: '' });
        assert.ok(/action=support_react$/.test(t.sent[1].url));
        done();
      });
    });
  });
});

test('closing a ticket', function (done) {
  var mode = 'fine';
  till(function () { return mode === 'fine' ? { status: 200, body: { success: true } } : { status: 404, body: { success: false, message: 'Support ticket not found.' } }; }, function (t) {
    t.core.supportClose(12, function (e1) {
      assert.ifError(e1);
      assert.deepStrictEqual(t.sent[0].body, { ticket_id: 12 });
      assert.ok(/action=support_close$/.test(t.sent[0].url));
      mode = 'gone';
      t.core.supportClose(13, function (e2) {
        assert.strictEqual(e2.message, 'Support ticket not found.');
        done();
      });
    });
  });
});

// ---- photos --------------------------------------------------------------------------------------------------------------------------------
test('a photo is fetched with the device key, and only for a real photo number', function (done) {
  till(function () { return { status: 200, body: { success: true } }; }, function (t) {
    assert.deepStrictEqual(t.core.supportPhotoRequest(70), { url: BASE + '?action=support_attachment&id=70', headers: { Authorization: 'Bearer key-1' } });
    assert.strictEqual(t.core.supportPhotoRequest('70; drop'), null);
    assert.strictEqual(t.core.supportPhotoRequest(1.5), null);
    assert.strictEqual(t.core.supportPhotoRequest(undefined), null);
    untilJoined(function (notJoined) {
      assert.strictEqual(notJoined.supportPhotoRequest(70), null);
      done();
    });
  });
});

// ---- times and words ---------------------------------------------------------------------------------------------------------------------
test('the server\'s times are UTC: 13:00 UTC is 16:00 in Nairobi', function (done) {
  assert.strictEqual(Core.supportTime('2026-10-06 13:00:21'), Date.parse('2026-10-06T13:00:21Z'));
  assert.strictEqual(Core.supportTime('2026-10-06T13:00:21Z'), Date.parse('2026-10-06T13:00:21Z'));
  assert.strictEqual(Core.supportTime('2026-10-06T13:00:21.123456Z'), Date.parse('2026-10-06T13:00:21.123Z'));
  assert.strictEqual(Core.supportTime(''), null);
  assert.strictEqual(Core.supportTime(null), null);
  assert.strictEqual(Core.supportTime('last week'), null);
  assert.strictEqual(Core.supportClock(Core.supportTime('2026-10-06 13:00:21')), '4:00 PM');
  done();
});

test('the clock reads 12 AM at midnight, 12 PM at noon, and pads the minutes', function (done) {
  function at(h, m) { return new Date(2026, 9, 6, h, m, 0).getTime(); }
  assert.strictEqual(Core.supportClock(at(0, 5)), '12:05 AM');
  assert.strictEqual(Core.supportClock(at(12, 0)), '12:00 PM');
  assert.strictEqual(Core.supportClock(at(9, 9)), '9:09 AM');
  assert.strictEqual(Core.supportClock(at(23, 59)), '11:59 PM');
  done();
});

test('the day heading: Today, Yesterday, then "Tue 6 Oct" - by the iPad\'s own days, even just after midnight', function (done) {
  function at(d, h, m) { return new Date(2026, 9, d, h, m, 0).getTime(); }
  var now = at(6, 0, 10);
  assert.strictEqual(Core.supportDayLabel(at(6, 0, 1), now), 'Today');
  assert.strictEqual(Core.supportDayLabel(at(5, 23, 59), now), 'Yesterday');
  assert.strictEqual(Core.supportDayLabel(at(4, 12, 0), now), 'Sun 4 Oct');
  assert.strictEqual(Core.supportDayLabel(at(1, 8, 0), at(6, 23, 59)), 'Thu 1 Oct');
  assert.strictEqual(Core.supportDayLabel(new Date(2026, 8, 30, 12, 0, 0).getTime(), now), 'Wed 30 Sep', 'across a month end');
  done();
});

test('the ticket status in words, and the reactions offered', function (done) {
  assert.strictEqual(Core.supportStatusLabel('pending'), 'Reply from support');
  assert.strictEqual(Core.supportStatusLabel('closed'), 'Closed');
  assert.strictEqual(Core.supportStatusLabel('open'), 'Waiting for support');
  assert.strictEqual(Core.supportStatusLabel('anything'), 'Waiting for support');
  assert.deepStrictEqual(Core.SUPPORT_REACTIONS, ['❤️', '👍', '👎', '😂', '‼️', '❓']);
  done();
});

// ---- running -------------------------------------------------------------------------------------------------------------------------------
var failed = 0;
var index = 0;
(function next() {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite support tests passed: ' + tests.length + ' tests.');
    return;
  }
  var t = tests[index++];
  var finished = false;
  var timer = setTimeout(function () { if (!finished) { finished = true; failed++; console.error('FAIL ' + t.name + '\n  timed out'); next(); } }, 5000);
  try {
    t.fn(function () { if (!finished) { finished = true; clearTimeout(timer); next(); } });
  } catch (error) {
    if (!finished) { finished = true; clearTimeout(timer); failed++; console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n  ') : error)); next(); }
  }
}());
process.on('uncaughtException', function (error) {
  console.error('FAIL (uncaught): ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n  ') : error));
  process.exit(1);
});
