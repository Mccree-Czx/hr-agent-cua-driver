package com.hragent.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

@Data
@ConfigurationProperties(prefix = "hr-agent")
public class HrAgentProperties {

    private Jwt jwt = new Jwt();

    private Auth auth = new Auth();

    private Liepin liepin = new Liepin();

    private Ai ai = new Ai();

    private Scoring scoring = new Scoring();

    private Storage storage = new Storage();

    private Notify notify = new Notify();

    private AutoRecruit autoRecruit = new AutoRecruit();

    private Cua cua = new Cua();

    @Data
    public static class Jwt {

        private String secret;

        private long expireHours = 12;
    }

    @Data
    public static class Auth {

        /** 无 token 时放行的路径 */
        private List<String> whitelist = new ArrayList<>();
    }

    @Data
    public static class Liepin {

        /** 多账号 user-data-dir 根目录 */
        private String dataDirBase = System.getProperty("user.home") + "/.liepin-cli/profiles";

        /** 搜索命令超时(分钟,200 条需翻页耗时较长) */
        private int searchTimeoutMinutes = 15;

        /** 简历/打招呼等短命令超时(分钟) */
        private int shortTimeoutMinutes = 3;

        /** 单次搜索返回候选人上限(实测翻页 200 会触发风控安全验证,50 为安全区间) */
        private int searchLimit = 50;
    }

    @Data
    public static class Ai {

        /** OpenAI 兼容接口 baseUrl(DeepSeek/Qwen/GLM 等) */
        private String baseUrl = "https://api.deepseek.com";

        private String apiKey = "";

        private String model = "deepseek-chat";

        /** 单次调用超时(秒) */
        private int timeoutSeconds = 120;

        /** AgentScope 技能包根目录(classpath 相对路径;agents/skills/<技能名>/SKILL.md,2026-09-28) */
        private String skillBaseDir = "agents/skills";
    }

    @Data
    public static class Scoring {

        /** 评分细则版本号(细则变更时更新;v2-star=星级模型 2026-09-29) */
        private String ruleVersion = "v2-star";

        /** 通过阈值(0-100) */
        private int passThreshold = 60;

        /** 评分技能名(AgentScope 技能包 agents/skills/<name>/SKILL.md;2026-09-28 由提示词文件迁移) */
        private String skillName = "resume-scoring";

        /** JSON 解析失败最大重试次数 */
        private int maxParseRetry = 2;

        /** 打招呼节奏:同账号两次打招呼最小间隔(秒) */
        private int greetIntervalSeconds = 60;
    }

    @Data
    public static class Storage {

        /** 存储实现类型:minio(默认)/local */
        private String type = "minio";

        /** 本地存储根目录(type=local 时生效) */
        private String localBaseDir = System.getProperty("user.home") + "/hr-agent/resumes";

        private Minio minio = new Minio();

        @Data
        public static class Minio {

            private String endpoint = "http://localhost:9000";

            private String accessKey = "hr-agent-minio";

            private String secretKey = "hr-agent-minio-pass";

            private String bucket = "resumes";
        }
    }

    @Data
    public static class AutoRecruit {

        /** 自动外发开关的首次种子(仅当 app_setting 中无值时生效;之后完全由界面开关控制,见 AutoRecruitSettingService) */
        private boolean enabled = false;

        /** 单轮单岗位打招呼上限(2026-09-28 晚工作量翻倍:15→30,与 60s 外发间隔共同压低密度) */
        private int greetBatchLimit = 30;

        /** 单轮自动索要上限(索要预算;2026-09-28 晚工作量翻倍:5→10) */
        private int askBatchLimit = 10;

        /** 单轮「在线简历详情」读取上限(只读平台调用;2026-09-28 晚工作量翻倍:10→20) */
        private int resumeDetailBatchLimit = 20;

        /** 轮内简历详情读取总预算(跨岗位合计;2026-09-28 晚工作量翻倍:30→60) */
        private int resumeDetailRoundLimit = 60;

        /** 相邻两次简历详情读取的最小间隔(毫秒,读操作轻节流,默认 2000;2026-09-28 由 1000 下调速率) */
        private int resumeDetailIntervalMillis = 2000;

        /** 会话列表(chatlist)拉取失败后的轮内重试等待(毫秒,默认 20s;测试置 1) */
        private int pollRetryDelayMillis = 20_000;

        /** 平摊窗口(分钟):整点轮次在窗口内匀速执行全部平台动作,到期未完成顺延下轮(2026-09-28 节拍改造) */
        private int spreadMinutes = 50;

        /** 相邻两个动作的最小间隔(毫秒;自适应节拍的提速下限,2026-09-28) */
        private int paceMillis = 30_000;

        /** 相邻两个动作的最大间隔(毫秒;自适应节拍的降速上限,防止动作过度稀疏,2026-09-28) */
        private int maxPaceMillis = 120_000;

        /** 轮内会话列表刷新间隔(分钟;刷新后新来信进入当轮处理队列,2026-09-28) */
        private int pollListIntervalMinutes = 15;

        /** 推荐任务创建/执行的最小间隔(分钟;防"任务接力"暴发,2026-09-28) */
        private int recommendGapMinutes = 8;

        /** 疑似拦截冻结退避时长(分钟):首次命中冻结,到期复测一次;0=回退"立即熔断"(2026-09-28) */
        private int riskProbeBackoffMinutes = 15;

        /** 整点轮次 cron(2026-09-29 时段延长为 06:00–23:00) */
        private String roundCron = "0 0 6-23 * * *";

        /** 4-5 星专道窗口 cron(每小时 :51–:59,不占轮内预算;2026-09-29) */
        private String starTailCron = "0 51 6-22 * * *";
    }

    @Data
    public static class Notify {

        /** 飞书自定义机器人 webhook(留空则仅日志告警) */
        private String feishuWebhook = "";

        /** 飞书机器人签名密钥(机器人开启加签时必填,未开启留空) */
        private String feishuSecret = "";
    }

    @Data
    public static class Cua {

        /** Node 可执行文件(node dist/cli/index.js 调用方式) */
        private String nodePath = "node";

        /** cua-liepin-driver CLI 入口脚本绝对路径(指向 tools/cua-liepin-driver/dist/cli/index.js) */
        private String scriptPath = "";

        /** cua-driver 可执行文件(留空则由适配器从 PATH 查找) */
        private String driverBin = "";
    }
}