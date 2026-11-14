// Scripted fake Anthropic Messages API for the rig (H0). Listens on the rig's loopback only; Claude Code is pointed at
// it with ANTHROPIC_BASE_URL and a fake key. No network, no credentials. Fake data only.
//   node fake-anthropic.mjs <port> <request log>
// The scenario is chosen by a trigger word in the newest user text ("H0-PERM", "H0-ASK1", "H0-ASKM", "H0-PLAN"; CV9:
// "H0-ASKQ" and "H0-ASKR", AskUserQuestion with several questions).
// CV8 (Stop): "H0-SLOW" streams one text delta and then holds the stream open (the agent is working until it is
// interrupted or HOLD_MS passes); "H0-TOOL" asks for a long Bash call (`timeout 40 tail -f notes.txt`, allowed by the harness; a bare `sleep` is refused by Claude Code, and /dev asks).
// A request whose last message holds a tool_result gets a closing text reply. Requests without tools (Claude Code's
// helper calls: title, command-prefix) get a short text reply.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [, , portArg, logPath] = process.argv;
const log = (o) => appendFileSync(logPath, `${JSON.stringify(o)}\n`);

const SCRIPTS = {
  'H0-PERM': { name: 'Bash', input: { command: 'cargo test --workspace', description: 'Run the Project Alpha tests' } },
  'H0-ASK1': {
    name: 'AskUserQuestion',
    input: {
      questions: [{
        question: 'Question Title 123: which approach should Agent 1 take?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Option A', description: 'Rewrite the parser in Project Alpha' },
          { label: 'Option B', description: 'Patch the existing parser' },
          { label: 'Option C', description: 'Leave it as it is' },
        ],
      }],
    },
  },
  'H0-ASKM': {
    name: 'AskUserQuestion',
    input: {
      questions: [{
        question: 'Question Title 123: which checks should Agent 1 run?',
        header: 'Checks',
        multiSelect: true,
        options: [
          { label: 'Lint', description: 'Run the linter' },
          { label: 'Typecheck', description: 'Run the type checker' },
          { label: 'Unit tests', description: 'Run cargo test' },
        ],
      }],
    },
  },
  // CV9: three questions in one call (Claude Code's tabbed question UI): single, multi-select, single.
  'H0-ASKQ': {
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Question Title 123: which approach should Agent 1 take?',
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Option A', description: 'Rewrite the parser in Project Alpha' },
            { label: 'Option B', description: 'Patch the existing parser' },
            { label: 'Option C', description: 'Leave it as it is' },
          ],
        },
        {
          question: 'Question Title 456: which checks should Agent 1 run?',
          header: 'Checks',
          multiSelect: true,
          options: [
            { label: 'Lint', description: 'Run the linter' },
            { label: 'Typecheck', description: 'Run the type checker' },
            { label: 'Unit tests', description: 'Run cargo test' },
          ],
        },
        {
          question: 'Question Title 789: where should Agent 1 deploy?',
          header: 'Target',
          multiSelect: false,
          options: [
            { label: 'Staging', description: 'The Project Alpha staging box' },
            { label: 'Nowhere', description: 'Do not deploy yet' },
          ],
        },
      ],
    },
  },
  // CV9: two questions, the multi-select one last (what its last row is, and where Enter on it goes).
  'H0-ASKR': {
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Question Title 321: which branch should Agent 1 use?',
          header: 'Branch',
          multiSelect: false,
          options: [
            { label: 'main', description: 'The Project Alpha main branch' },
            { label: 'next', description: 'The Project Alpha next branch' },
          ],
        },
        {
          question: 'Question Title 654: which docs should Agent 1 update?',
          header: 'Docs',
          multiSelect: true,
          options: [
            { label: 'README', description: 'The top README' },
            { label: 'CHANGELOG', description: 'The change log' },
          ],
        },
      ],
    },
  },
  'H0-TOOL': { name: 'Bash', input: { command: 'timeout 40 tail -f notes.txt', description: 'Wait for the Project Alpha build' } },
  'H0-PLAN': {
    name: 'ExitPlanMode',
    input: { plan: '# Plan for Project Alpha\n\n1. Split the parser into three passes\n2. Add tests with cargo test\n3. Update the docs' },
  },
};

const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (c.some((b) => b.type === 'tool_result')) return { toolResult: true, text: '' };
    const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (t) return { toolResult: false, text: t };
  }
  return { toolResult: false, text: '' };
};

let n = 0;
/** How long an "H0-SLOW" stream stays open before it ends by itself. */
const HOLD_MS = 60_000;

/** A streamed reply that starts and then holds: Claude Code shows it as working until Esc aborts the request. */
function slow(req, res, model) {
  const id = `msg_fake_${++n}`;
  const usage = { input_tokens: 10, output_tokens: 5 };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Agent 1 is working on Project Alpha.' } });
  let ended = false;
  const timer = setTimeout(() => {
    ended = true;
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
    log({ slow: id, ended: 'by itself' });
  }, HOLD_MS);
  res.on('close', () => {
    clearTimeout(timer);
    if (!ended) log({ slow: id, ended: 'client closed' });
  });
}
const sse = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

function reply(res, model, blocks, stream) {
  const id = `msg_fake_${++n}`;
  const usage = { input_tokens: 10, output_tokens: 5 };
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
  });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* not JSON */ }
    const url = req.url ?? '';
    if (url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (!url.startsWith('/v1/messages')) {
      log({ unhandled: req.method, url });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake' } }));
      return;
    }
    const model = body.model ?? 'claude-fake-1';
    const toolNames = (body.tools ?? []).map((t) => t.name);
    const messages = body.messages ?? [];
    const { toolResult, text } = lastUserText(messages);
    const allText = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'))).join('\n');
    const trigger = Object.keys(SCRIPTS).find((k) => allText.includes(k));
    const used = (name) => messages.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && b.name === name));
    log({ url, model, tools: toolNames.length, toolNames: toolNames.join(','), toolResult, trigger: trigger ?? null, stream: !!body.stream });
    if (toolNames.length > 0 && !toolResult && body.stream && text.includes('H0-SLOW')) return slow(req, res, model);
    const wantPlan = trigger === 'H0-PLAN';
    const planFile = (JSON.stringify(messages).match(/(\/[^\s"\\`]*\/plans\/[^\s"\\`]+\.md)/) ?? [])[1];
    let blocks;
    if (wantPlan && toolNames.length > 0 && !used('ExitPlanMode')) {
      if (!toolNames.includes('ExitPlanMode') && !used('ToolSearch') && toolNames.includes('ToolSearch')) {
        blocks = [{ type: 'tool_use', id: `toolu_fake_${++n}`, name: 'ToolSearch', input: { query: 'select:ExitPlanMode', max_results: 1 } }];
      } else if (!used('Write') && planFile) {
        blocks = [{ type: 'text', text: 'Agent 1 writes the plan.' }, { type: 'tool_use', id: `toolu_fake_${++n}`, name: 'Write', input: { file_path: planFile, content: SCRIPTS['H0-PLAN'].input.plan } }];
      } else if (toolNames.includes('ExitPlanMode')) {
        blocks = [{ type: 'text', text: 'Agent 1 will ask now.' }, { type: 'tool_use', id: `toolu_fake_${++n}`, name: 'ExitPlanMode', input: { plan: SCRIPTS['H0-PLAN'].input.plan } }];
      } else blocks = [{ type: 'text', text: 'Agent 1: ok.' }];
    } else if (toolNames.length === 0) blocks = [{ type: 'text', text: 'cargo test' }];
    else if (trigger && !used(SCRIPTS[trigger].name) && toolNames.includes(SCRIPTS[trigger].name)) {
      blocks = [{ type: 'text', text: 'Agent 1 will ask now.' }, { type: 'tool_use', id: `toolu_fake_${++n}`, ...SCRIPTS[trigger] }];
    } else if (trigger && !used(SCRIPTS[trigger].name) && !used('ToolSearch') && toolNames.includes('ToolSearch')) {
      // Deferred tool (ExitPlanMode): load it through ToolSearch first.
      blocks = [{ type: 'tool_use', id: `toolu_fake_${++n}`, name: 'ToolSearch', input: { query: `select:${SCRIPTS[trigger].name}`, max_results: 1 } }];
    } else blocks = [{ type: 'text', text: toolResult ? 'Agent 1: done.' : 'Agent 1: ok.' }];
    reply(res, model, blocks, !!body.stream);
  });
}).listen(Number(portArg), '127.0.0.1', () => log({ listening: Number(portArg) }));
