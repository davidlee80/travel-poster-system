-- 开发期定价（价目表版本 2）
--
-- ## 为什么需要它，而 0013 的版本 1 不够
--
-- 0013 种下的版本 1 是**占位**：九个数是为了让表非空而填的，从来没有
-- 与任何东西核对过。而它与注册赠送额（`CREDIT_SIGNUP_GRANT_CR`，默认 9900 CR）
-- 恰好不兼容 —— 实测占位价下一次 14 天行程要冻 10578 CR，
-- 也就是刚注册的用户点「生成 14 天」直接拿到 402。
--
-- 两个互不相干的占位数凑在一起必然出现这类矛盾，因此实现把版本 1 视为
-- 「还没配价」并**不计费**（见 apps/api 的 CreditsService.priceBook）。
-- 那让系统跑得起来，代价是**计费链路在开发期一次都不会被走到** ——
-- 而一条没人跑的链路会烂掉。
--
-- 这一版就是那条链路的开发期输入：数字按「能跑通」选，不是按成本选。
--
-- ## 选数的判据只有一条
--
-- **连 14 天的最坏上界都要落在注册赠送额之内。**
--
-- ```text
-- 天数   典型 CR   上界 CR   预留 CR（× 120%）   9900 CR 能买几次
--    5       767      1379                921                 10
--    7      1047      2198               1257                  7
--   14      2317      5938               2781                  3
-- ```
--
-- 上界 5938 < 9900：因此**任何天数、任何重生成次数**下，一个刚注册的用户都能
-- 生成成功。只保证「典型值不超」是不够的 —— 那会让「重生成两次」这条路径
-- 变成一个只在特定条件下出现的 402，而它恰恰最难复现。
--
-- ## 这不是运营定价
--
-- `@tps/billing` 的 `isProvisionalPriceBook()` 把版本 ≤ 2 判为「由迁移种下的
-- 临时定价」，api 启动时因此仍会打一条 warn。运营上线前的动作是
-- clone 到版本 3 并按真实供应商成本改价（见 docs/用户货币与计费.md 第八节），
-- 那一刻这条 warn 自然消失。
--
-- **改价不要原地改这一版** —— 版本号是判据，在版本 2 上改价等于
-- 「改完了系统仍然认为这是开发期定价」。

SELECT clone_credit_prices(1, 2, '开发期定价：数字按「能跑通」选，上界落在注册赠送额之内');

/*
 * 逐项更新。用 VALUES 表连接而不是九条 UPDATE：漏改一项时这里会剩下
 * 版本 1 的占位值，而那一项恰好是「看起来配好了、其实没改」的形态。
 */
UPDATE credit_price_items AS i
SET price_cr = dev.price_cr
FROM credit_price_versions AS v,
     (VALUES
        ('plan.base_fee',     50::BIGINT),
        ('llm.in:*',          4000),
        ('llm.out:*',         15000),
        ('embedding.in:*',    100),
        ('image.ai_generate', 100),
        ('image.search',      10),
        ('render.page',       5),
        ('export.png',        20),
        ('export.pdf',        30)
     ) AS dev(sku, price_cr)
WHERE i.version_id = v.id AND v.version = 2 AND i.sku = dev.sku;

/*
 * 九项一项不少。数量不对说明 0013 的种子项与这里的清单漂移了 ——
 * 而漂移的表现是某个 SKU 仍按占位价计费，没有任何迹象。
 */
DO $$
DECLARE
    updated INTEGER;
BEGIN
    SELECT count(*) INTO updated
    FROM credit_price_items i
    JOIN credit_price_versions v ON v.id = i.version_id
    WHERE v.version = 2
      AND (i.sku, i.price_cr) IN (
        ('plan.base_fee', 50), ('llm.in:*', 4000), ('llm.out:*', 15000),
        ('embedding.in:*', 100), ('image.ai_generate', 100), ('image.search', 10),
        ('render.page', 5), ('export.png', 20), ('export.pdf', 30)
      );
    IF updated <> 9 THEN
        RAISE EXCEPTION '开发期定价只写入了 % 项，应为 9 项', updated;
    END IF;
END $$;

SELECT publish_credit_prices(2);

COMMENT ON TABLE credit_price_items IS
    '价目明细。sku 形如 llm.in:<model>，:* 为该域兜底价。price_cr 是含毛利的售价，代码不再乘倍率。版本 1（占位）与 2（开发期）由迁移种下，运营定价从版本 3 起';
