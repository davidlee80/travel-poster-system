import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  LocalHashingEmbeddingClient,
  cosineSimilarity,
  hashingVector,
  toVectorLiteral,
  tokenize,
} from './embedding.js';

/**
 * 向量化（TP-2-21）。
 *
 * 这些断言的目标不是「向量算得准」——哈希向量器本来就只表达词汇重合度——
 * 而是「3.2.4 的 0.75 余弦阈值在这个向量空间里有区分度」。若相关与不相关的
 * 文本余弦都落在 0.9 附近，那个阈值就等于没有，检索会把任何同城计划都
 * 当成参考塞进 LLM 上下文。
 */

describe('切词', () => {
  it('中文按双字滑窗', () => {
    expect(tokenize('西湖')).toEqual(['西湖']);
    expect(tokenize('京杭大运河')).toEqual(['京杭', '杭大', '大运', '运河']);
  });

  it('单字成词时保留', () => {
    expect(tokenize('茶')).toEqual(['茶']);
  });

  it('英文与数字按词切分并小写化', () => {
    expect(tokenize('Hangzhou West Lake 2026')).toEqual(['hangzhou', 'west', 'lake', '2026']);
  });

  it('标点与空白不产生词', () => {
    expect(tokenize('，。！ \n\t')).toEqual([]);
  });
});

describe('向量', () => {
  it('维度与 plan_embedding 列一致', () => {
    // 不一致时 pgvector 会在插入时报错，但那是运行期才发现
    expect(hashingVector('杭州运河')).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('已归一化', () => {
    const vector = hashingVector('杭州运河与西湖人文');
    const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('确定性：同一文本永远同一向量', () => {
    expect(hashingVector('杭州运河')).toEqual(hashingVector('杭州运河'));
  });

  it('空文本返回零向量而不是 NaN', () => {
    // 归一化时除以 0 会让整条向量变成 NaN，而 pgvector 会接受它，
    // 之后所有余弦比较都返回 NaN —— 表现为「这条计划永远召回不到」
    const vector = hashingVector('。。。');
    expect(vector.every((v) => v === 0)).toBe(true);
  });
});

describe('余弦相似度与 0.75 阈值', () => {
  const RETRIEVAL_THRESHOLD = 0.75;

  const hangzhouCanal =
    '目的地：杭州\n行程：拱宸桥与大运河博物馆｜拱宸桥\n行程：大兜路历史街区漫步｜大兜路\n美食：片儿川';
  const hangzhouCanalVariant =
    '目的地：杭州\n行程：大运河博物馆与拱宸桥｜拱宸桥\n行程：大兜路老街漫步｜大兜路\n美食：片儿川';
  const hangzhouWestLake =
    '目的地：杭州\n行程：断桥与白堤｜西湖\n行程：雷峰塔远眺｜雷峰塔\n美食：西湖醋鱼';
  const beijing = '目的地：北京\n行程：故宫太和殿｜故宫\n行程：景山公园登高｜景山\n美食：炸酱面';

  it('同主题的两份计划超过阈值', () => {
    expect(
      cosineSimilarity(hashingVector(hangzhouCanal), hashingVector(hangzhouCanalVariant)),
    ).toBeGreaterThan(RETRIEVAL_THRESHOLD);
  });

  it('同城不同主题低于阈值', () => {
    /*
     * 这条是阈值有效性的关键。3.2.4 已经按 place_id 过滤，候选集全是同城计划；
     * 若同城不同主题也超过 0.75，向量排序就退化成「随便给 5 份同城计划」。
     */
    expect(
      cosineSimilarity(hashingVector(hangzhouCanal), hashingVector(hangzhouWestLake)),
    ).toBeLessThan(RETRIEVAL_THRESHOLD);
  });

  it('不同城市的相似度远低于同城', () => {
    const sameCity = cosineSimilarity(
      hashingVector(hangzhouCanal),
      hashingVector(hangzhouWestLake),
    );
    const otherCity = cosineSimilarity(hashingVector(hangzhouCanal), hashingVector(beijing));
    expect(otherCity).toBeLessThan(sameCity);
  });

  it('自身相似度为 1', () => {
    expect(cosineSimilarity(hashingVector(beijing), hashingVector(beijing))).toBeCloseTo(1, 6);
  });

  it('维度不一致时抛错而不是静默返回 0', () => {
    // 静默返回 0 会让「换了维度」表现为「什么都召回不到」，
    // 而那种症状最容易被归因到数据不足
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/维度不一致/);
  });
});

describe('LocalHashingEmbeddingClient', () => {
  it('批量返回与输入等长', async () => {
    const client = new LocalHashingEmbeddingClient();
    const vectors = await client.embed(['杭州运河', '北京故宫']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('model 标识里带维度', () => {
    // 维度即向量空间，换了就不可比；标识里带着它才能查出哪些行需要重算
    expect(new LocalHashingEmbeddingClient().model).toBe('local-hashing-1536');
    expect(new LocalHashingEmbeddingClient(64).model).toBe('local-hashing-64');
  });
});

describe('pgvector 字面量', () => {
  it('形如 [a,b,c]', () => {
    expect(toVectorLiteral([0.5, -0.25, 0])).toBe('[0.5,-0.25,0]');
  });
});
