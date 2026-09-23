import { z } from 'zod';

/**
 * Tool input schemas. Kept in one place so the MCP server, the CLI and tests
 * agree on the contract, and so schema changes are visible in review.
 */

const evidenceSchema = z.object({
  kind: z.enum(['code', 'commit', 'doc', 'user_message', 'file', 'other']).default('code'),
  relativePath: z.string().optional(),
  symbol: z.string().optional(),
  commitSha: z.string().optional(),
  fingerprint: z.string().optional(),
  snippet: z.string().optional(),
  note: z.string().optional(),
});

export const projectInitSchema = {
  rootPath: z.string().describe('项目根目录的绝对路径'),
  name: z.string().optional().describe('项目显示名称，默认取目录名'),
};

export const beginTaskSchema = {
  projectRoot: z.string().describe('项目根目录的绝对路径；Cloonex 会自动注册项目'),
  title: z.string().describe('本次任务名称'),
  taskType: z
    .enum(['feature', 'refactor', 'bugfix', 'query', 'unknown'])
    .describe('任务类型。bugfix 不学习偏好，unknown 默认不写入记录'),
  featureSlug: z.string().optional().describe('关联功能的稳定标识，如 order-export'),
  intent: z.string().optional().describe('本次要实现什么'),
  inScope: z.string().optional().describe('可以改动的范围'),
  outOfScope: z.string().optional().describe('必须保持不变的行为'),
  constraints: z.string().optional().describe('约束，如复用组件、禁止新增依赖'),
  doneCriteria: z.string().optional().describe('出现什么结果才算完成'),
  stack: z.string().optional().describe('技术栈标识，如 vue3 / react；用于加载按栈限定的偏好'),
  scene: z
    .string()
    .optional()
    .describe('业务场景标识，如 admin-page / marketing-page；用于加载按场景限定的界面偏好'),
};

export const getContextSchema = {
  taskId: z.string().optional().describe('任务 ID；与 projectRoot 二选一'),
  projectRoot: z.string().optional().describe('项目根目录；未给 taskId 时返回未完成任务列表'),
  maxChars: z.number().int().positive().optional().describe('上下文预算上限，默认 12000 字符'),
};

export const recordDecisionSchema = {
  taskId: z.string().describe('任务 ID'),
  title: z.string().describe('决定标题'),
  choice: z.string().describe('实际采用的方案'),
  reason: z.string().optional().describe('选择的理由；没有依据时留空，不要猜测'),
  reasonSource: z
    .enum(['user_explicit', 'user_confirmed', 'project_rule', 'external_doc', 'unknown'])
    .default('unknown')
    .describe('理由来源。只有用户明确表达才能用 user_explicit'),
  consequence: z.string().optional(),
  featureSlug: z.string().optional(),
  evidence: z.array(evidenceSchema).optional(),
};

export const saveCheckpointSchema = {
  taskId: z.string(),
  summary: z.string().describe('当前进展摘要'),
  changed: z.string().optional().describe('已改动的内容'),
  remaining: z.string().optional().describe('未完成事项'),
};

export const finalizeTaskSchema = {
  taskId: z.string(),
  outcome: z.string().optional().describe('最终完成情况'),
  verification: z.string().optional().describe('实际执行过的检查；未执行的不要填写'),
  statements: z
    .array(
      z.object({
        featureSlug: z.string().describe('功能标识'),
        section: z
          .enum(['purpose', 'flow', 'interaction', 'implementation', 'rule', 'dependency', 'verification'])
          .describe('说明所属部分'),
        content: z.string(),
        relativePaths: z.array(z.string()).optional().describe('支撑该说明的代码文件（项目相对路径）'),
      }),
    )
    .optional(),
  feature: z
    .object({
      slug: z.string(),
      title: z.string(),
      purpose: z.string().optional(),
      boundary: z.string().optional(),
    })
    .optional(),
};

export const queryFeatureSchema = {
  projectRoot: z.string().describe('项目根目录'),
  query: z.string().describe('功能名称、关键词或问题'),
  includeHistory: z.boolean().optional().describe('是否包含已被替代的历史决定'),
};

export const proposePreferenceSchema = {
  taskId: z.string().describe('任务 ID；任务类型必须允许学习偏好'),
  title: z.string(),
  content: z.string().describe('可执行的规则内容'),
  scope: z.enum(['global', 'project', 'stack', 'scene']).default('project'),
  stack: z.string().optional(),
  scene: z.string().optional(),
  confirm: z.boolean().optional().describe('用户是否明确要求长期采用；true 才写入 confirmed'),
  evidence: z.array(evidenceSchema).optional(),
};

export const managePreferenceSchema = {
  action: z.enum(['list', 'confirm', 'revoke', 'supersede']).describe('对偏好执行的操作'),
  preferenceId: z.string().optional().describe('list 之外的操作需要提供'),
  projectRoot: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  scope: z.enum(['global', 'project', 'stack', 'scene']).optional(),
};

export const staleCheckSchema = {
  projectRoot: z.string().describe('项目根目录'),
};

export const exportContextSchema = {
  taskId: z.string(),
  outFile: z.string().optional().describe('输出文件路径；默认写入数据目录的 exports 下'),
};

export const dataInfoSchema = {
  detail: z.boolean().optional().describe('是否包含每张表的记录数'),
};

export const addConventionSchema = {
  projectRoot: z.string().describe('项目根目录的绝对路径'),
  category: z.string().describe('约定类别，如 stack / layering / naming / testing / design'),
  content: z.string().describe('约定内容'),
  source: z.string().optional().describe('来源，如用户说明、现有代码、项目文档'),
};

export const reviewStatementSchema = {
  statementId: z.string().describe('功能说明 ID'),
  reviewState: z.enum(['verified', 'needs_review', 'stale', 'unknown']).describe('核对后的状态'),
};

export const projectListSchema = {};

export const taskListSchema = {
  projectRoot: z.string(),
  limit: z.number().int().positive().max(100).optional(),
};

export const taskUpdateSchema = {
  taskId: z.string(),
  status: z.enum(['open', 'blocked', 'done', 'abandoned']).optional(),
  taskType: z.enum(['feature', 'refactor', 'bugfix', 'query', 'unknown']).optional().describe('修正任务类型；会同时重算学习范围'),
  intent: z.string().optional(),
  inScope: z.string().optional(),
  outOfScope: z.string().optional(),
  constraints: z.string().optional(),
  doneCriteria: z.string().optional(),
  outcome: z.string().optional(),
  verification: z.string().optional(),
  featureSlug: z.string().optional(),
  stack: z.string().optional().describe('调整技术栈；影响按栈限定的偏好是否加载'),
  scene: z.string().optional().describe('调整业务场景；影响按场景限定的界面偏好是否加载'),
};
