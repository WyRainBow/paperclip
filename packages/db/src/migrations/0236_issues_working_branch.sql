-- The branch `issue start --branch` records only landed in the opening
-- comment's prose, so "which branch is this card on" was unanswerable without
-- reading comments (MUL-59). One structured column, written by issue start.
ALTER TABLE "issues" ADD COLUMN "working_branch" text;
