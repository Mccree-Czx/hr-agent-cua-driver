package com.hragent.scoring;

import com.hragent.entity.ScoreRecord;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 单候选人评分的事务边界(终审 I3②)。
 *
 * <p>{@link ScoringEngine#scorePending(Long)} 逐候选人调用本 bean;每次调用开启一个
 * {@link Propagation#REQUIRES_NEW} 独立事务,确保某位候选人评分异常(及其未完成写入)只回滚自身,
 * 不影响同批其余候选人已提交的结果——避免「批次单事务 + self-invocation 代理绕过」导致的整批回滚。
 */
@Service
public class CandidateScoringExecutor {

    private final ScoringEngine scoringEngine;

    public CandidateScoringExecutor(ScoringEngine scoringEngine) {
        this.scoringEngine = scoringEngine;
    }

    /** 在独立事务中完成单候选人评分落库 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public ScoreRecord scoreInNewTransaction(Long candidateId) {
        return scoringEngine.scoreAndSave(candidateId);
    }
}
