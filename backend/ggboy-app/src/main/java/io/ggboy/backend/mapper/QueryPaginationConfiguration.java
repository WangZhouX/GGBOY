package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.enums.SqlMethod;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.core.toolkit.ParameterUtils;
import com.baomidou.mybatisplus.core.toolkit.PluginUtils;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.InnerInterceptor;
import com.baomidou.mybatisplus.extension.plugins.pagination.DialectModel;
import com.baomidou.mybatisplus.extension.plugins.pagination.dialects.PostgreDialect;
import java.util.List;
import java.util.Set;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.BoundSql;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.mapping.ParameterMapping;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 为金库、借贷快照和交易活动的免计数查询启用 PostgreSQL 物理分页。
 * Enables physical PostgreSQL pagination for vault snapshots, lending snapshots and transaction activity without a total count.
 */
@Configuration(proxyBeanMethods = false)
public class QueryPaginationConfiguration {

    /**
     * 注册处理快照和交易活动分页的 MyBatis-Plus 拦截器。
     * Registers a MyBatis-Plus interceptor scoped to snapshot and transaction activity pagination.
     *
     * @return 使用现有 PostgreSQL 方言生成分页语句的拦截器。
     *         Interceptor that generates pagination using the existing PostgreSQL dialect.
     */
    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        // 分页限制在 MyBatis 生成缓存键之前写入，缓存可区分页大小和偏移量。
        // Apply the page before MyBatis creates the cache key so size and offset distinguish cached results.
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new NonCountingPageInterceptor());
        return interceptor;
    }

    /**
     * 针对传入免计数 Page 的快照和活动交易列表生成分页。
     * Generates pagination for snapshot and activity transaction queries supplied with a non-counting page.
     */
    private static final class NonCountingPageInterceptor implements InnerInterceptor {

        /**
         * 可启用物理分页的 Mapper 内置列表语句 ID。
         * Built-in mapper list statements eligible for physical pagination.
         */
        private static final Set<String> PAGED_LISTS = Set.of(
                VaultSnapshotMapper.class.getName() + "." + SqlMethod.SELECT_LIST.getMethod(),
                VaultPositionSnapshotMapper.class.getName() + "." + SqlMethod.SELECT_LIST.getMethod(),
                LendingMarketSnapshotMapper.class.getName() + "." + SqlMethod.SELECT_LIST.getMethod(),
                LendingPositionSnapshotMapper.class.getName() + "." + SqlMethod.SELECT_LIST.getMethod(),
                ChainTransactionMapper.class.getName() + "." + SqlMethod.SELECT_LIST.getMethod()
        );

        /** MyBatis-Plus 自带的 PostgreSQL 分页方言。 Built-in MyBatis-Plus PostgreSQL pagination dialect. */
        private final PostgreDialect dialect = new PostgreDialect();

        /**
         * 在查询送达数据库前绑定分页参数。
         * Binds page parameters before the query reaches the database.
         *
         * @param executor 当前 MyBatis 执行器。 Current MyBatis executor.
         * @param statement 当前映射语句，按 ID 确认所属 Mapper。 Mapped statement identifying the mapper by its ID.
         * @param parameter 包含条件与 Page 的查询参数。 Query parameters containing conditions and the page.
         * @param rowBounds MyBatis 客户端行范围。 MyBatis client-side row bounds.
         * @param resultHandler MyBatis 结果处理器。 MyBatis result handler.
         * @param boundSql 含已绑定查询条件的语句。 Statement with bound query conditions.
         */
        @Override
        @SuppressWarnings("rawtypes")
        public void beforeQuery(
                Executor executor, MappedStatement statement, Object parameter, RowBounds rowBounds,
                ResultHandler resultHandler, BoundSql boundSql
        ) {
            if (!PAGED_LISTS.contains(statement.getId())) {
                return;
            }

            // 仅处理开启分页且关闭计数的请求。
            // Handle only requests that enable pagination and disable counting.
            IPage<?> page = ParameterUtils.findPage(parameter).orElse(null);
            if (page == null || page.searchCount() || page.getSize() <= 0) {
                return;
            }

            // 方言根据 Page 生成数据库分页并绑定页大小，原条件的参数映射一起保留。
            // Let the dialect generate physical pagination and bind the page size, preserving the original predicates.
            PluginUtils.MPBoundSql query = PluginUtils.mpBoundSql(boundSql);
            DialectModel paging = dialect.buildPaginationSql(query.sql(), page.offset(), page.getSize());
            List<ParameterMapping> parameters = query.parameterMappings();
            paging.consumers(parameters, statement.getConfiguration(), query.additionalParameters());
            query.sql(paging.getDialectSql());
            query.parameterMappings(parameters);
        }
    }
}
