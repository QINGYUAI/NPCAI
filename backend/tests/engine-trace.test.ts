/**
 * [M4.3.0] trace_id 贯穿单测
 *
 * 覆盖矩阵（6 条）
 *   1. generateTraceId 启用时产出 uuid v4 格式
 *   2. TRACE_ID_ENABLED=false 时返回 null（M4.2 行为回退）
 *   3. shortTrace：short 格式 8 字符；full 格式 36 字符；null→''
 *   4. isValidTraceId：uuid v4 通过；空/非法字符/长度错 拒绝
 *   5. logAiCall：trace_id 作为最后一个参数写入 INSERT ai_call_log（18 列）
 *   6. insertReflections：同一 trace_id 被 3 条 reflection 共享（7 参数一组），并透传到反哺 storeMemory
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 全文件共享一套 mock：pool.execute / pool.query / chatCompletion / storeMemory / getMemoryConfig */
const { executeMock, queryMock, chatMock, storeMemoryMock, configMock } = vi.hoisted(() => ({
  executeMock: vi.fn(async (sql: string) => {
    if (String(sql).includes('INSERT INTO npc_reflection')) {
      return [{ insertId: 777, affectedRows: 3 }, null];
    }
    return [{ insertId: 0, affectedRows: 1 }, null];
  }),
  queryMock: vi.fn(async () => [
    [
      {
        id: 1,
        npc_id: 1,
        scene_id: 1,
        tick: 1,
        type: 'observation',
        content: 'x',
        importance: 5,
        created_at: new Date(),
      },
    ],
    null,
  ]),
  chatMock: vi.fn(async () =>
    JSON.stringify({
      items: [
        { theme: 'goal', content: 'g' },
        { theme: 'emotion', content: 'e' },
        { theme: 'relation', content: 'r' },
      ],
    }),
  ),
  storeMemoryMock: vi.fn(async () => ({ id: null, embedded: false, status: null })),
  configMock: vi.fn(() => ({
    enabled: true,
    embedModel: 'x',
    embedDim: 1536,
    topK: 3,
    retentionDays: 30,
    storeMode: 'sync' as const,
    retrieveQueryMode: 'prev_summary_plus_neighbors' as const,
    embedAiConfigId: 0,
    qdrant: { url: '', apiKey: undefined, collection: 'x', vectorSize: 1536 },
    embedCache: { enabled: false, ttlDays: 0, dir: '' },
    reflection: { everyNTick: 5, recentMemoryK: 20 },
  })),
}));

vi.mock('../src/db/connection.js', () => ({
  pool: { execute: executeMock, query: queryMock },
}));
vi.mock('../src/utils/llmClient.js', () => ({ chatCompletion: chatMock }));
vi.mock('../src/engine/memory/store.js', () => ({ storeMemory: storeMemoryMock }));
vi.mock('../src/engine/memory/config.js', () => ({
  getMemoryConfig: configMock,
  resetMemoryConfig: () => {},
}));

describe('[M4.3.0] engine/trace 工具', () => {
  const originalEnabled = process.env.TRACE_ID_ENABLED;
  const originalFormat = process.env.TRACE_ID_LOG_FORMAT;

  afterEach(() => {
    process.env.TRACE_ID_ENABLED = originalEnabled;
    process.env.TRACE_ID_LOG_FORMAT = originalFormat;
  });

  it('用例1：TRACE_ID_ENABLED=true 时 generateTraceId 产出 uuid v4 格式', async () => {
    process.env.TRACE_ID_ENABLED = 'true';
    const trace = await import('../src/engine/trace.js');
    const id = trace.generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(trace.isTraceEnabled()).toBe(true);
  });

  it('用例2：TRACE_ID_ENABLED=false 时 generateTraceId 返回 null（M4.2 行为回退）', async () => {
    process.env.TRACE_ID_ENABLED = 'false';
    const trace = await import('../src/engine/trace.js');
    expect(trace.isTraceEnabled()).toBe(false);
    expect(trace.generateTraceId()).toBeNull();
  });

  it('用例3：shortTrace 按 TRACE_ID_LOG_FORMAT 切换 short/full；null→空串', async () => {
    const trace = await import('../src/engine/trace.js');
    const uuid = '9f8c1b3a-7e5d-4f2a-8c4b-d3a5b6c7e8f0';
    process.env.TRACE_ID_LOG_FORMAT = 'short';
    expect(trace.shortTrace(uuid)).toBe('9f8c1b3a');
    process.env.TRACE_ID_LOG_FORMAT = 'full';
    expect(trace.shortTrace(uuid)).toBe(uuid);
    expect(trace.shortTrace(null)).toBe('');
    expect(trace.shortTrace(undefined)).toBe('');
  });

  it('用例4：isValidTraceId 仅接受 uuid 36 字符格式', async () => {
    const trace = await import('../src/engine/trace.js');
    expect(trace.isValidTraceId('9f8c1b3a-7e5d-4f2a-8c4b-d3a5b6c7e8f0')).toBe(true);
    expect(trace.isValidTraceId('')).toBe(false);
    expect(trace.isValidTraceId('not-a-uuid')).toBe(false);
    /** 缺横杠的 32 字符 hex 不通过 */
    expect(trace.isValidTraceId('9f8c1b3a7e5d4f2a8c4bd3a5b6c7e8f0')).toBe(false);
    expect(trace.isValidTraceId(12345)).toBe(false);
    expect(trace.isValidTraceId(null)).toBe(false);
  });
});

describe('[M4.3.0] aiLogger 写入 ai_call_log.trace_id', () => {
  beforeEach(() => {
    executeMock.mockClear();
  });

  it('用例5：logAiCall SQL 含 trace_id 列，18 参数，末位为传入值', async () => {
    const { logAiCall } = await import('../src/utils/aiLogger.js');
    logAiCall({
      api_type: 'chat',
      provider: 'openai',
      status: 'success',
      trace_id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    });
    /** aiLogger 是 fire-and-forget Promise，稍等微任务 */
    await new Promise((r) => setTimeout(r, 10));
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [sql, params] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO ai_call_log[\s\S]*trace_id\)/);
    expect(sql).toMatch(
      /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/,
    );
    expect(params).toHaveLength(18);
    expect(params[17]).toBe('aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee');
  });
});

describe('[M4.3.0] reflect.insertReflections 把 trace_id 贯穿到 3 条 INSERT + 反哺', () => {
  beforeEach(() => {
    executeMock.mockClear();
    storeMemoryMock.mockClear();
  });

  it('用例6：同一 traceId 以 7 参数一组贯穿 3 条 npc_reflection INSERT，并透传到反哺 storeMemory', async () => {
    const { reflectIfTriggered } = await import('../src/engine/reflection/reflect.js');
    const scene = { id: 1, name: 's', description: null, width: 1, height: 1 };
    const npc = {
      id: 1,
      name: 'n',
      personality: null,
      system_prompt: null,
      simulation_meta: null,
      ai_config_id: 1,
    };
    const aiCfg = {
      id: 1,
      provider: 'openai',
      api_key: 'x',
      base_url: null,
      model: 'm',
      max_tokens: 100,
    };
    const fixedTrace = 'deadbeef-1234-4fff-8888-aaaaaaaaaaaa';
    const r = await reflectIfTriggered({
      scene,
      npc,
      tick: 5,
      prevSummary: '',
      aiCfg,
      dryRun: false,
      traceId: fixedTrace,
    });

    expect(r.status).toBe('generated');

    /** INSERT npc_reflection：SQL 含 trace_id 列，7 参数一组 */
    const reflInsert = executeMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO npc_reflection'),
    );
    expect(reflInsert).toBeDefined();
    const [sql, params] = reflInsert as [string, unknown[]];
    expect(sql).toMatch(
      /\(npc_id, scene_id, tick, theme, content, source_memory_ids, trace_id\)/,
    );
    expect(sql).toMatch(/\(\?, \?, \?, \?, \?, \?, \?\)/);
    expect(params).toHaveLength(3 * 7);
    expect(params[6]).toBe(fixedTrace);
    expect(params[13]).toBe(fixedTrace);
    expect(params[20]).toBe(fixedTrace);

    /** 反哺 storeMemory 也要带同一 trace_id */
    expect(storeMemoryMock).toHaveBeenCalledTimes(3);
    for (const call of storeMemoryMock.mock.calls) {
      expect((call[0] as { traceId?: string }).traceId).toBe(fixedTrace);
    }
  });
});
