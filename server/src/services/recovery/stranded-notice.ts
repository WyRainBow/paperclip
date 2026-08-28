import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import {
  agentLinkRow,
  keyValueRow,
  runLinkRow,
  systemNoticePresentation,
  type NoticeMetadataRow,
  type NoticeMetadataSection,
} from "./notice-format.js";
import { RECOVERY_ACTION_ROW_LABEL } from "./successful-run-handoff.js";

// Short human-readable body plus the presentation header for one recovery
// family. The escalation path merges in the metadata rows only it knows
// (recovery action, owner, source run) via buildStrandedRecoveryEscalationNotice.
export type StrandedRecoveryNoticeSeed = {
  body: string;
  title: string;
  tone: IssueCommentPresentation["tone"];
};

export type StrandedRecoveryEscalationNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

export const DEFAULT_STRANDED_RECOVERY_NOTICE_BODY =
  "Paperclip 没能自动为这张卡恢复出一条活的执行路径。" +
  "已移至 `blocked`，等人来处理。";

const DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE = "自动恢复被挡住";

const STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE: Record<string, string> = {
  workspace_validation_failed: "工作区校验失败",
  configuration_incomplete: "配置不完整",
  execution_review_participant_recovery: "评审恢复卡住",
};

export function buildImmediateExecutionPathRecoveryNoticeSeed(input: {
  status: "todo" | "in_progress";
}): StrandedRecoveryNoticeSeed {
  const retryDescription = input.status === "todo"
    ? "Paperclip 在终端运行恢复期间自动重派了这张指派中的 `todo` 卡"
    : "Paperclip 在终端运行恢复期间自动重试了这张进行中（`in_progress`）卡的续跑";
  return {
    body:
      `${retryDescription}，但仍没有活的执行路径。` +
      "已移至 `blocked` 以便人工介入。",
    title: "没有活的执行路径",
    tone: "danger",
  };
}

export function buildWorkspaceValidationRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "工作区校验没过，Paperclip 在启动本地适配器之前就停了。" +
      "已移至 `blocked`，先修好工作区链接、工作目录或 git 检出再续跑。",
    title: "工作区校验失败",
    tone: "danger",
  };
}

export function buildConfigurationIncompleteRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "缺少必需的密钥或环境变量绑定，Paperclip 在派发适配器之前就停了。" +
      "已移至 `blocked`，先把缺的密钥绑上再续跑。",
    title: "配置不完整",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "Paperclip 重试了一次待处理的执行评审参与方，但评审阶段仍然既没有完成的裁决，也没有活的评审运行。" +
      "已移至 `blocked`，请 board 查看证据，修好评审运行环境、恢复评审阶段，或者显式记录一个人工结论。",
    title: "评审恢复卡住",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantUnavailableNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "待处理的执行评审参与方不可调用，且评审阶段既没有完成的裁决也没有活的评审运行，Paperclip 无法继续。" +
      "已移至 `blocked`，请 board 查看证据，修好评审运行环境、恢复评审阶段，或者显式记录一个人工结论。",
    title: "评审恢复卡住",
    tone: "danger",
  };
}

// Escalation dedupe matches the `Recovery action` key_value row via
// noticeMetadataReferencesRecoveryAction, so this builder must always emit
// that row with the raw action id.
export function buildStrandedRecoveryEscalationNotice(input: {
  seed?: StrandedRecoveryNoticeSeed | null;
  fallbackBody?: string | null;
  recoveryCause?: string | null;
  recoveryActionId: string;
  recoveryOwner: { id: string; name: string | null } | null | undefined;
  sourceRun: {
    id: string;
    agentId?: string | null;
    status: string;
    errorCode?: string | null;
    errorSummary?: string | null;
  } | null | undefined;
}): StrandedRecoveryEscalationNotice {
  const fallbackBody = input.fallbackBody?.trim();
  const body = input.seed?.body ?? (fallbackBody || DEFAULT_STRANDED_RECOVERY_NOTICE_BODY);
  const title = input.seed?.title ??
    STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE[input.recoveryCause ?? ""] ??
    DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE;

  const recoveryRows: NoticeMetadataRow[] = [
    keyValueRow(RECOVERY_ACTION_ROW_LABEL, input.recoveryActionId),
    input.recoveryOwner
      ? agentLinkRow("恢复负责人", input.recoveryOwner)
      : keyValueRow(
          "恢复负责人",
          "需要 board 拍板",
        ),
    keyValueRow(
      "下一步",
      input.recoveryOwner
        ? "恢复负责人要么恢复出一条活的执行路径，要么在来源卡上记录人工结论"
        : "查看证据，然后重试原负责人、显式改派、修好执行路径，或者记录一个明确的结论",
    ),
  ];

  const runRows: NoticeMetadataRow[] = [];
  if (input.sourceRun) {
    runRows.push(runLinkRow("来源运行", input.sourceRun));
    const failureCode = input.sourceRun.errorCode?.trim();
    if (failureCode) runRows.push(keyValueRow("失败代码", failureCode));
    const failureSummary = input.sourceRun.errorSummary?.trim();
    if (failureSummary) runRows.push(keyValueRow("失败摘要", failureSummary));
  }

  const sections: NoticeMetadataSection[] = [
    { title: "恢复", rows: recoveryRows },
    ...(runRows.length > 0 ? [{ title: "运行证据", rows: runRows }] : []),
  ];

  return {
    body,
    presentation: systemNoticePresentation({ tone: input.seed?.tone ?? "danger", title }),
    metadata: {
      version: 1,
      sourceRunId: input.sourceRun?.id ?? null,
      sections,
    },
  };
}
