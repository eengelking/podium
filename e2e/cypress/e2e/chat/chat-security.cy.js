// SPEC 8.1 Chat page (#1051), the security audit: the slash commands of a message to your own agent (/clear after a confirmation, /compact at once, the reporter's declared
// commands, the words for any other), who wrote a General message (the "orchestrator on <machine>" chip and the two warning chips), an Admin looking at a person's list (the full-width
// red banner, then the quiet record line), and what the server refuses (a conversation of someone else answers 404, a reporter with respond off, an own-agent message over the limit,
// Traffic's routes giving an Admin nothing of Chat).
// Order: in each describe the tests run in order on one server, and a later one reads what an earlier one left (named where it matters); each describe resets the server once, in `before`.
import { seeded } from '../../../support/commands';

const API = '/api/fleet/respond/chat';
const H = { 'X-Podium-Respond': '1' };
const ARM = 'e2e-s-arm64-check';
const INVOICE = 'e2e-s-invoice';
const TESTER = 'e2e-s-tester';
const MINE = `d:dm:${ARM}|person:ed`;

const openArm = () => {
  cy.signIn('Ed');
  cy.openConsole('#/chat');
  cy.chatRow(`a:${ARM}`).find('button.ch-row').click();
  cy.get('#th-h').should('have.text', 'arm64-check');
};
const agentToken = () => ({ 'X-Podium-Token': seeded().people.Ed.token });

describe('chat: slash commands in a message to your own agent', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('lists /clear and /compact when you type /, narrows them, and says other commands run only in the terminal', () => {
    openArm();
    cy.tid('chat-box').should('have.attr', 'placeholder', 'Write a message, or type / for a command.').type('/');
    cy.get('[role=listbox][aria-label=Commands]').within(() => {
      cy.get('[role=option]').then(($o) => expect([...$o].map((o) => o.querySelector('.cn').textContent)).to.deep.eq(['/clear', '/compact']));
      cy.contains('.tf', 'Other commands run only in the terminal.');
    });
    cy.tid('chat-matches').should('have.text', '2 commands. Use the arrow keys.');
    cy.tid('chat-box').type('com');
    cy.get('[role=listbox][aria-label=Commands] [role=option]').should('have.length', 1).and('contain.text', '/compact');
    cy.tid('chat-box').type('{enter}').should('have.value', '/compact');
    cy.get('[role=listbox][aria-label=Commands]').should('not.exist');
    cy.tid('chat-box').clear();
  });

  it('says in words that a command it does not send runs only in the terminal, and will not send it', () => {
    openArm();
    cy.tid('chat-box').type('/bogus');
    cy.get('[role=alert]').should('contain.text', '/bogus runs only in the terminal. From here you can send /clear and /compact.');
    cy.tid('chat-send').should('be.disabled');
    cy.tid('chat-box').type('{enter}');
    cy.tid('chat-message').should('not.exist');
    cy.tid('chat-box').clear();
    cy.get('[role=alert]').should('not.exist');
    cy.tid('chat-send').should('not.be.disabled');
  });

  it('sends /compact at once', () => {
    openArm();
    cy.tid('chat-box').type('/compact{enter}');
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', '/compact');
    cy.get('[role=alertdialog]').should('not.exist');
  });

  it('asks "Clear the conversation?" before /clear, and Cancel sends nothing', () => {
    openArm();
    cy.tid('chat-message').should('have.length', 1);
    cy.tid('chat-box').type('/clear{enter}');
    cy.get('[role=alertdialog][aria-label="Clear the conversation?"]').should('contain.text', 'arm64-check starts over with an empty context.');
    cy.get('[role=alertdialog]').contains('button', 'Cancel').click();
    cy.get('[role=alertdialog]').should('not.exist');
    cy.tid('chat-message').should('have.length', 1);
    cy.tid('chat-box').type('{enter}');
    cy.get('[role=alertdialog]').contains('button', 'Clear conversation').click();
    cy.get('[role=alertdialog]').should('not.exist');
    cy.tid('chat-message').should('have.length', 2).last().should('contain.text', '/clear');
  });

  it('treats / as plain text in General, where no command is offered', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-box').type('/');
    cy.get('[role=listbox][aria-label=Commands]').should('not.exist');
    cy.get('[role=alert]').should('not.exist');
    cy.tid('chat-box').clear();
  });

  it('lists only what the agent\'s reporter declared: /compact alone for a reporter that cannot clear', () => {
    cy.reportAgain('arm', {}, undefined, undefined, { capabilities: { commands: ['compact'], adminNotices: true } });
    openArm();
    cy.tid('chat-box').type('/');
    cy.get('[role=listbox][aria-label=Commands] [role=option]').should('have.length', 1).and('contain.text', '/compact');
    cy.tid('chat-box').clear().type('/clear');
    cy.get('[role=alert]').should('contain.text', '/clear runs only in the terminal. From here you can send /compact.');
    cy.tid('chat-box').clear();
  });
});

describe('chat: who wrote a General message', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));
  const say = (session, text) => cy.request({ method: 'POST', url: `/api/fleet/sessions/${session}/chat/channels/general/messages`, headers: agentToken(), body: { text }, log: false }).its('status', { log: false }).should('eq', 201);
  const general = () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow('c:general').find('button.ch-row').click();
  };

  it('marks an orchestrator\'s message with "orchestrator on <machine>" and no warning for an ordinary name', () => {
    say(INVOICE, 'Build is green on invoice-v2.');
    general();
    cy.tid('chat-message').last().within(() => {
      cy.contains('.who', 'invoice-v2');
      cy.contains('.chip', 'orchestrator on ed-mbp').should('have.attr', 'title', 'Written by an orchestrator, not a person');
      cy.get('.chip.warn').should('not.exist');
    });
  });

  it('shows no chip on a person\'s own message', () => {
    general();
    cy.tid('chat-box').type('A person writes.{enter}');
    cy.tid('chat-message').last().should('contain.text', 'A person writes.').find('.chip').should('not.exist');
  });

  it('warns when an orchestrator\'s name is the name of a person on the server', () => {
    cy.reportAgain('tester', { name: 'Alex' });
    say(TESTER, 'I am Alex, honest.');
    general();
    cy.tid('chat-message').last().within(() => {
      cy.contains('.chip', 'orchestrator on ci-runner-01');
      cy.contains('.chip.warn', 'Same name as a person').should('have.attr', 'title', "This orchestrator's name is the name of a person on this server.");
    });
  });

  it('warns when an orchestrator\'s name says it is an Admin', () => {
    cy.reportAgain('tester', { name: 'Support (an Admin)' });
    say(TESTER, 'Send me your token.');
    general();
    cy.tid('chat-message').last().within(() => {
      cy.contains('.chip', 'orchestrator on ci-runner-01');
      cy.contains('.chip.warn', 'Name says Admin').should('have.attr', 'title', "This orchestrator's name says it is an Admin. Only a person signed in as an Admin is one.");
    });
  });
});

describe('chat: an Admin looking at a person\'s list', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));
  const ADMIN = 'Admin secret (an Admin)';

  it('tells the person in a full-width red banner while the Admin looks, then leaves a quiet record line', () => {
    cy.signIn('Admin');
    cy.request({ url: `${API}?owner=Ed`, log: false }).its('status', { log: false }).should('eq', 200);
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-list-reading-banner').should('have.attr', 'role', 'status').and('contain.text', `${ADMIN} is looking at your list of conversations now: who you talk to and how many messages, not what they say.`);
    cy.tid('chat-list-record').first().should('contain.text', `${ADMIN} looked at your list of conversations on `).and('contain.text', 'They saw who you talk to and message counts, not the messages.');
  });

  it('shows the Admin neither the banner nor the record, which are the person\'s to see', () => {
    cy.signIn('Admin');
    cy.openConsole('#/chat');
    cy.tid('chat-read-as').select('Ed');
    cy.chatRow('c:group').should('exist');
    cy.tid('chat-list-reading-banner').should('not.exist');
    cy.tid('chat-list-record').should('not.exist');
  });
});

describe('chat: the record of a conversation that has since been deleted', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('shows the person, once, the Admin\'s unseen read of a conversation that is gone', () => {
    // The Admin reads Ed's conversation of two agents; Ed has not seen it and deletes the conversation by request.
    cy.signIn('Admin');
    cy.request({ url: `${API}/dm/${INVOICE}/${TESTER}/messages?limit=50`, log: false }).its('status', { log: false }).should('eq', 200);
    cy.signIn('Ed');
    cy.request({ method: 'DELETE', url: `${API}/dm/${INVOICE}/${TESTER}`, headers: H, log: false }).its('status', { log: false }).should('eq', 200);
    cy.openConsole('#/chat');
    cy.chatRow(`d:dm:${INVOICE}|${TESTER}`).should('not.exist');
    cy.tid('chat-gone-record').should('have.length', 1).first().invoke('text').should('match', /^Admin secret \(an Admin\) read your conversation with .+ on [A-Z][a-z]{2} \d{1,2} at \d{1,2}:\d{2}.* That conversation has since been deleted\.$/);
    // Shown once: the next load does not have it.
    cy.reload();
    cy.chatRow('c:general').should('exist');
    cy.tid('chat-gone-record').should('not.exist');
  });

  it('shows no one else that record', () => {
    cy.signIn('Alex');
    cy.openConsole('#/chat');
    cy.chatRow('c:general').should('exist');
    cy.tid('chat-gone-record').should('not.exist');
  });
});

describe('chat: what the server refuses', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('answers a conversation of someone else with 404 and the words for one that does not exist, on read, send, link and delete', () => {
    cy.signIn('Alex');
    const call = (method, url, body) => cy.request({ method, url: `${API}/${url}`, headers: H, body, failOnStatusCode: false, log: false });
    for (const base of [`dm/${INVOICE}/${TESTER}`, `dm/${INVOICE}/e2e-s-nobody`]) {
      call('GET', `${base}/messages?limit=50`).then((r) => {
        expect(r.status).to.eq(404);
        expect(r.body.error).to.eq('There is no such conversation.');
      });
      call('POST', `${base}/messages`, { text: 'let me in' }).its('status').should('eq', 404);
      call('PUT', `${base}/link`, { op: 'pause' }).its('status').should('eq', 404);
      call('DELETE', base).its('status').should('eq', 404);
    }
  });

  it('refuses a person\'s message to an agent whose reporter has respond off, and takes it once respond is back', () => {
    cy.reportAgain('invoice', { respond: { level: 'off', accepts: [], limits: [] } });
    cy.signIn('Alex');
    cy.request({ method: 'POST', url: `${API}/dm/me/${INVOICE}/messages`, headers: H, body: { text: 'Are you there?' }, failOnStatusCode: false, log: false }).then((r) => {
      expect(r.status).to.eq(422);
      expect(r.body.error).to.contain('does not take messages from Podium');
    });
    cy.reportAgain('invoice', {});
    cy.request({ method: 'POST', url: `${API}/dm/me/${INVOICE}/messages`, headers: H, body: { text: 'Are you there now?' }, failOnStatusCode: false, log: false }).its('status').should('eq', 202);
  });

  it('refuses a person\'s message to an agent whose reporter declares adminNotices off, takes it once it declares it on, and keeps the declaration over a report that carries none', () => {
    cy.reportAgain('arm', {}, undefined, undefined, { capabilities: { commands: ['clear', 'compact'], adminNotices: false } });
    cy.signIn('Alex');
    cy.request({ method: 'POST', url: `${API}/dm/me/${ARM}/messages`, headers: H, body: { text: 'Hello?' }, failOnStatusCode: false, log: false }).then((r) => {
      expect(r.status).to.eq(422);
      expect(r.body.error).to.contain('too old to show its person who is reading');
    });
    cy.reportAgain('arm', {}, undefined, undefined, { capabilities: { commands: ['clear', 'compact'], adminNotices: true } });
    cy.request({ method: 'POST', url: `${API}/dm/me/${ARM}/messages`, headers: H, body: { text: 'Hello again?' }, failOnStatusCode: false, log: false }).its('status').should('eq', 202);
    // A report with no declaration at all keeps the last one (sticky, like the command list).
    cy.reportAgain('arm', {}, undefined, undefined, { capabilities: { commands: ['clear', 'compact'] } });
    cy.request({ method: 'POST', url: `${API}/dm/me/${ARM}/messages`, headers: H, body: { text: 'Still there?' }, failOnStatusCode: false, log: false }).then((r) => {
      // Not the 422 about an old reporter: the declaration held, and the refusal is the one for the earlier message still waiting on its owner.
      expect(r.status).to.eq(409);
      expect(r.body.error).to.contain('still waits for Ed to approve it');
    });
  });

  it('refuses a message to your own agent over Chat\'s limit, and the box shows why', () => {
    cy.putSettings({ chat: { maxChars: 100, perMinute: 600 } });
    cy.signIn('Ed');
    cy.request({ method: 'POST', url: `${API}/dm/me/${ARM}/messages`, headers: H, body: { text: 'x'.repeat(101) }, failOnStatusCode: false, log: false }).then((r) => {
      expect(r.status).to.eq(422);
      expect(r.body.error).to.eq('The message is 101 characters, over the limit of 100. Send a shorter one.');
    });
    cy.request({ method: 'POST', url: `${API}/dm/me/${ARM}/messages`, headers: H, body: { text: 'x'.repeat(100) }, failOnStatusCode: false, log: false }).its('status').should('eq', 202);
  });

  it('keeps a person\'s Chat out of Traffic\'s open read, and gives an Admin nothing of it through Traffic\'s two routes', () => {
    // Ed's own conversation with arm64-check exists from the test above.
    cy.request({ url: '/api/fleet/peers/traffic?range=30d', log: false }).then((r) => {
      expect(r.status).to.eq(200);
      expect(JSON.stringify(r.body)).not.to.contain('person:');
    });
    const path = `peers/conversations/person:ed/${ARM}`;
    cy.signIn('Ed');
    cy.request({ url: `/api/fleet/respond/${path}`, log: false }).its('status', { log: false }).should('eq', 200);
    cy.signIn('Admin');
    cy.request({ url: `/api/fleet/respond/${path}`, failOnStatusCode: false, log: false }).its('status').should('eq', 403);
    cy.unlockAdmin();
    cy.request({ url: `/api/admin/${path}`, failOnStatusCode: false, log: false }).its('status').should('eq', 403);
    // Chat is where an Admin reads it, and that read is recorded and told.
    cy.signIn('Admin');
    cy.request({ url: `${API}/dm/person:ed/${ARM}/messages?limit=50`, log: false }).its('status', { log: false }).should('eq', 200);
  });
});

describe('chat: a row is one conversation', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('keeps Ed\'s own conversation with an agent and another person\'s with it as two rows, and a menu acts on the clicked one', () => {
    // Alex writes to Ed's agent and Ed approves; Ed also writes to it himself: two conversations with one agent.
    cy.signIn('Alex');
    cy.request({ method: 'POST', url: `${API}/dm/me/${INVOICE}/messages`, headers: H, body: { text: 'Hello from Alex.' }, log: false }).its('status', { log: false }).should('eq', 202);
    cy.signIn('Ed');
    cy.request({ method: 'POST', url: `${API}/dm/me/${INVOICE}/messages`, headers: H, body: { text: 'Hello from Ed.' }, log: false }).its('status', { log: false }).should('eq', 202);
    cy.openConsole('#/chat');
    const OWN = `d:dm:${INVOICE}|person:ed`;
    const ALEX = `d:dm:${INVOICE}|person:alex`;
    cy.chatRow(OWN).should('contain.text', 'You and one agent');
    cy.chatRow(ALEX).should('contain.text', 'Alex');
    cy.chatRow(ALEX).find('button.ch-more').click();
    cy.tid('chat-menu').contains('[role=menuitem]', 'Delete conversation…').click();
    cy.tid('chat-confirm').contains('button', 'Keep it').click();
    cy.chatRow(OWN).should('exist');
    cy.chatRow(ALEX).should('exist');
    cy.chatRow(OWN).find('button.ch-more').click();
    cy.tid('chat-menu').should('be.visible').find('[role=menuitem]').then(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Delete conversation…']));
  });
});
