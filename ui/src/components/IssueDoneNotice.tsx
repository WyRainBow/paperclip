import { History } from "lucide-react";

import { InlineBanner } from "@/components/InlineBanner";

export interface IssueDoneNoticeProps {
  issueStatus?: string | null;
}

/**
 * done = 过去时（MUL-490）：卡收了之后不再跟着现实改，所以正文和文档里写的是当时
 * 的事实。读的人要在读之前知道这一点，否则会把过期内容当成现状 —— 实测发生过两次
 * （MUL-466 正文、MUL-476 decision-log）。
 */
export function IssueDoneNotice({ issueStatus }: IssueDoneNoticeProps) {
  if (issueStatus !== "done") return null;

  return (
    <InlineBanner tone="info" compact icon={History} title="本 issue 为过去时">
      这张卡已经收了。里面写的是当时的事实，现在可能已经不成立，一切以当前为准；发现过期也不用回头改它。
    </InlineBanner>
  );
}
