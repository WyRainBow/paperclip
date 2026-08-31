-- Record how many query terms the corpus actually recognised (MUL-449).
--
-- `term_count` counts what the tokenizer produced, before terms that appear in
-- no document are dropped. Measured on the real corpus, that number hides the
-- exact case this table exists to catch:
--
--   「宇宙背景辐射的各向异性怎么测」  term=12  coverage=1.000  ← pure noise
--   「分支名要按什么格式起」          term=8   coverage=0.309  ← a good answer
--
-- The noise query scores a perfect coverage because df pruning left it with one
-- or two generic bigrams, and those matched completely. Coverage alone is
-- therefore backwards as a quality signal.
--
-- What separates the two is how much of the question survived pruning. Twelve
-- terms reduced to one means the corpus understood almost nothing of what was
-- asked, no matter how well that one term matched. Storing both counts makes
-- their ratio available, and that ratio is the honest signal.

ALTER TABLE "recall_queries" ADD COLUMN IF NOT EXISTS "scoring_term_count" integer;
