package io.ggboy.backend.api;

import java.time.Duration;
import java.time.Instant;

/**
 * API 查询返回的已观测快照的新鲜度。
 * Freshness of an observed snapshot returned by an API query.
 */
public enum SnapshotFreshness {

    /** 观测年龄处于配置阈值内。 Observation age is within the configured threshold. */
    FRESH,

    /** 观测年龄已超过配置阈值。 Observation age exceeds the configured threshold. */
    STALE;

    /**
     * 使用对应业务配置的阈值判断快照新鲜度。
     * Evaluates snapshot freshness against the configured threshold for the feature.
     *
     * @param observedAt 索引器记录的 UTC 观测时刻。 UTC observation time recorded by the indexer.
     * @param now 本次响应统一使用的服务端时刻。 Server time shared by the response.
     * @param maxAge 允许的最大观测年龄，为正时长。 Positive maximum observation age.
     * @return 观测年龄严格超过阈值时返回 STALE。 STALE when the observation age strictly exceeds the threshold.
     */
    public static SnapshotFreshness at(Instant observedAt, Instant now, Duration maxAge) {
        return Duration.between(observedAt, now).compareTo(maxAge) > 0 ? STALE : FRESH;
    }
}
