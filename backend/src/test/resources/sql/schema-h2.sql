-- H2 测试库结构(与生产 schema.sql 对应,H2 MODE=MySQL)

CREATE TABLE IF NOT EXISTS jd (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    title         VARCHAR(200) NOT NULL,
    external_jd   TEXT,
    internal_notes TEXT,
    city          VARCHAR(50),
    district      VARCHAR(50),
    job_category  VARCHAR(100),
    experience_req VARCHAR(50),
    degree_req    VARCHAR(20),
    salary_months INT NOT NULL DEFAULT 13,
    salary_min    INT,
    salary_max    INT,
    status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    publish_status VARCHAR(20) NOT NULL DEFAULT 'NOT_PUBLISHED',
    liepin_job_id VARCHAR(50),
    publish_error VARCHAR(500),
    score_threshold INT,
    threshold_suggestion VARCHAR(500),
    threshold_confirmed_by BIGINT,
    threshold_confirmed_at DATETIME,
    scoring_pref_confirmed_at DATETIME,
    scoring_pref_confirmed_by BIGINT,
    min_comm_star INT NOT NULL DEFAULT 3,
    bonus_points TEXT,
    veto_points  TEXT,
    other_requirements TEXT,
    source        VARCHAR(20) NOT NULL DEFAULT 'LOCAL',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS liepin_account (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    name             VARCHAR(100) NOT NULL,
    user_data_dir    VARCHAR(500),
    login_status     VARCHAR(20) NOT NULL DEFAULT 'NEED_SCAN',
    circuit_breaker  TINYINT NOT NULL DEFAULT 0,
    greet_mode       VARCHAR(20) NOT NULL DEFAULT 'AUTO',
    daily_greet_quota INT NOT NULL DEFAULT 50,
    risk_reset_at    TIMESTAMP,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS search_task (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    jd_id          BIGINT NOT NULL,
    account_id     BIGINT NOT NULL,
    task_type      VARCHAR(20) NOT NULL DEFAULT 'SEARCH',
    keywords       VARCHAR(500),
    status         VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    lease_expire_at DATETIME,
    retry_count    INT NOT NULL DEFAULT 0,
    error_msg      VARCHAR(1000),
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS candidate (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    resume_id     VARCHAR(100) NOT NULL,
    name          VARCHAR(100) NOT NULL,
    snapshot      TEXT,
    score         INT,
    star          TINYINT,
    pass_status   VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    recruit_status VARCHAR(30) NOT NULL DEFAULT 'PENDING_REVIEW',
    veto_confirmed_by BIGINT,
    veto_confirmed_at TIMESTAMP,
    resume_last_viewed_at TIMESTAMP,
    resume_last_viewed_by BIGINT,
    jd_id         BIGINT,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_resume UNIQUE (resume_id, name)
);

CREATE TABLE IF NOT EXISTS score_record (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    candidate_id BIGINT NOT NULL,
    jd_id        BIGINT NOT NULL,
    score        INT,
    star         TINYINT,
    reason       TEXT,
    rule_version VARCHAR(50),
    veto_suspects TEXT,
    bonus_hits   TEXT,
    pref_snapshot TEXT,
    model        VARCHAR(50),
    token_usage  INT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS greeting_record (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    candidate_id BIGINT NOT NULL,
    account_id   BIGINT NOT NULL,
    liepin_job_id VARCHAR(50),
    attach_probe_msg_id VARCHAR(64),
    resume_requested_at TIMESTAMP,
    resume_request_count INT DEFAULT 0 NOT NULL,
    message      TEXT,
    status       VARCHAR(20) NOT NULL DEFAULT 'SENT',
    mode         VARCHAR(20) NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_candidate UNIQUE (candidate_id)
);

CREATE TABLE IF NOT EXISTS resume_file (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    candidate_id BIGINT NOT NULL,
    bucket       VARCHAR(100),
    object_key   VARCHAR(500),
    format       VARCHAR(20),
    size         BIGINT,
    sha256       VARCHAR(64),
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sys_user (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    username   VARCHAR(100) NOT NULL,
    password   VARCHAR(200) NOT NULL,
    role       VARCHAR(20) NOT NULL DEFAULT 'HR',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_username UNIQUE (username)
);

CREATE TABLE IF NOT EXISTS user_jd (
    id      BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    jd_id   BIGINT NOT NULL,
    CONSTRAINT uk_user_jd UNIQUE (user_id, jd_id)
);

CREATE TABLE IF NOT EXISTS op_log (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    operator    VARCHAR(100),
    action      VARCHAR(50),
    target_type VARCHAR(50),
    target_id   VARCHAR(50),
    detail      TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_setting (
    setting_key   VARCHAR(100) PRIMARY KEY,
    setting_value TEXT,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auto_recruit_round (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    started_at   DATETIME,
    finished_at  DATETIME NOT NULL,
    mode         VARCHAR(20) NOT NULL,
    polled       INT NOT NULL DEFAULT 0,
    scored       INT NOT NULL DEFAULT 0,
    greeted      INT NOT NULL DEFAULT 0,
    recommended  INT NOT NULL DEFAULT 0,
    errors       INT NOT NULL DEFAULT 0,
    risk_stopped BOOLEAN NOT NULL DEFAULT FALSE,
    no_account   BOOLEAN NOT NULL DEFAULT FALSE,
    stats_json   TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
