package com.hragent.dto;

import com.hragent.entity.Candidate;
import com.hragent.entity.GreetingRecord;
import com.hragent.entity.ResumeFile;
import com.hragent.entity.ScoreRecord;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/** 候选人台账行(搜索→评分→打招呼→简历入库 全流程状态) */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class CandidateLedger {

    private Candidate candidate;

    private ScoreRecord latestScore;

    private GreetingRecord greeting;

    private ResumeFile resumeFile;

    /** 简历最后查看人显示名(未查看为 null;前端本人展示为"我") */
    private String lastViewedByName;
}
