package com.hragent.dto;

import com.hragent.entity.Candidate;
import com.hragent.entity.ResumeFile;
import com.hragent.entity.ScoreRecord;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/** 候选人详情(抽屉三区:基本信息 / AI 评分 / 简历资料;参照 HR Portal V2 结构) */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class CandidateDetail {

    private Candidate candidate;

    /** 来源岗位名称(无岗位为 null) */
    private String jdTitle;

    /** 最近一条评分记录(未评分为 null) */
    private ScoreRecord latestScore;

    /** 简历文件元数据(未入库为 null) */
    private ResumeFile resumeFile;

    /** 简历展示文件名(去除候选人 ID 前缀) */
    private String resumeFileName;

    /** 最后查看人显示名(未查看为 null) */
    private String lastViewedByName;
}
