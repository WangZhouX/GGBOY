package io.ggboy.backend.persistence;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableFieldInfo;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.baomidou.mybatisplus.core.toolkit.StringUtils;
import io.ggboy.backend.entity.AssetMintDO;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.entity.ChainEventDO;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import io.ggboy.backend.entity.ChainTransactionDO;
import io.ggboy.backend.entity.IndexerCheckpointDO;
import io.ggboy.backend.entity.LendingMarketDO;
import io.ggboy.backend.entity.LendingMarketSnapshotDO;
import io.ggboy.backend.entity.LendingPositionSnapshotDO;
import io.ggboy.backend.entity.RiskAlertDO;
import io.ggboy.backend.entity.VaultDO;
import io.ggboy.backend.entity.VaultPositionSnapshotDO;
import io.ggboy.backend.entity.VaultSnapshotDO;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** 验证持久化对象的框架映射，可结合本地 SQL 草案逐列核验。 Verifies framework mappings and checks each column when the local SQL draft is available. */
public class DataObjectMappingTest {

    /** 草案中每张表先声明所有列，再声明主键。 The schema declares all columns of each table before its primary key. */
    private static final Pattern TABLE = Pattern.compile(
            "(?ms)^CREATE TABLE (\\w+) \\(\\R(.*?)^\\h*PRIMARY KEY \\(([^)]+)\\)");

    /** 读取单列的数据库名称和带精度的 SQL 类型。 Reads the SQL column name and type, including precision. */
    private static final Pattern COLUMN = Pattern.compile("\\s*([a-z_]+)\\s+([a-z]+(?:\\([0-9,]+\\))?).*");

    /**
     * 校验实体命名、全部构造参数的列映射以及复合主键的更新策略。
     * Checks entity names, column mappings for every constructor component, and update policies for composite keys.
     */
    @Test
    public void mapsPublishedRowTypes() {
        // 已发布的持久化类型均应通过 MyBatis-Plus 的实际元数据初始化。
        // Initialize the actual MyBatis-Plus metadata for each published persistence type.
        var rowTypes = List.of(ChainTransactionDO.class, ChainEventDO.class, ChainEventParticipantDO.class,
                ChainEventAssetDO.class, IndexerCheckpointDO.class, AssetMintDO.class, VaultDO.class,
                LendingMarketDO.class, VaultSnapshotDO.class, LendingMarketSnapshotDO.class,
                VaultPositionSnapshotDO.class, LendingPositionSnapshotDO.class, RiskAlertDO.class);
        var assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "published-row-mapping-test");
        for (var type : rowTypes) {
            // 表名去掉类名的 DO 后缀后转为下划线命名。
            // The table name uses snake case after removing the DO suffix from the class name.
            String name = type.getSimpleName();
            assertTrue(type.isRecord() && name.endsWith("DO"), name);
            var metadata = TableInfoHelper.initTableInfo(assistant, type);
            assertEquals(StringUtils.camelToUnderline(name.substring(0, name.length() - 2)), metadata.getTableName());
            assertNull(metadata.getKeyProperty(), name);
            var columns = metadata.getFieldList();
            var components = type.getRecordComponents();
            assertEquals(components.length, columns.size(), name);
            for (int index = 0; index < components.length; index++) {
                // 逐列检查属性名和列名，避免返回列和 record 构造参数错位。
                // Check column and property names to prevent mismatches with record constructor arguments.
                String property = components[index].getName();
                assertEquals(property, columns.get(index).getProperty(), name);
                assertEquals(StringUtils.camelToUnderline(property), columns.get(index).getColumn(), name);
            }
            // 每张表至少有两列属于复合主键，实体更新时必须排除这些列。
            // Each table has at least two composite key columns excluded from entity-based updates.
            assertTrue(columns.stream().filter(field -> field.getUpdateStrategy() == FieldStrategy.NEVER).count() >= 2,
                    name);
        }
    }

    /**
     * 校验每张表、全部列的构造顺序、数据类型及复合主键处理。
     * Checks every table, the constructor order and type of every column, and composite key handling.
     *
     * @throws IOException 无法读取数据库设计文件。 The schema file cannot be read.
     * @throws ReflectiveOperationException 某张表缺少对应的类型或字段。 A table has no corresponding type or mapped field.
     */
    @Test
    public void mapsEverySchemaColumn() throws IOException, ReflectiveOperationException {
        // SQL 草案由开发者在本地维护，公开检出时将这项额外核对标记为跳过。
        // The SQL draft is maintained locally. Report this additional check as skipped in a public checkout.
        var schema = findSchema();
        assumeTrue(schema.isPresent(), "Local docs/backend/schema.sql is unavailable");
        // 使用运行期的 MyBatis-Plus 元数据检查自动生成 SQL 可以看到的列。
        // Use runtime MyBatis-Plus metadata to check the columns visible to generated SQL.
        var assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "row-mapping-test");
        var tables = TABLE.matcher(Files.readString(schema.orElseThrow()));
        assertTrue(tables.find(), "No CREATE TABLE definitions found");
        do {
            // 根据数据库表名及统一的实体包生成约定类名，让新建表自动纳入校验。
            // Derive the DO name in the shared entity package so new tables are automatically covered.
            String table = tables.group(1);
            String camelName = StringUtils.underlineToCamel(table);
            String className = Character.toUpperCase(camelName.charAt(0)) + camelName.substring(1) + "DO";
            Class<?> type = Class.forName("io.ggboy.backend.entity." + className);
            assertTrue(type.isRecord(), table);
            var tableMapping = type.getAnnotation(TableName.class);
            assertNotNull(tableMapping, table);
            assertEquals(table, tableMapping.value(), className);
            // 复合键的列还需要从框架生成的 SET 子句中排除。
            // Composite key columns must also be excluded from framework-generated SET clauses.
            var primaryKey = List.of(tables.group(3).split(",\\s*"));
            assertTrue(primaryKey.size() > 1, table);

            // 单字段主键元数据会使按 ID 的读写跳过复合键中的其他条件。
            // Single-column ID metadata would let ID-based CRUD omit other parts of the composite key.
            var metadata = TableInfoHelper.initTableInfo(assistant, type);
            assertNull(metadata.getKeyProperty(), table);
            assertEquals(table, metadata.getTableName());

            // SQL 顺序与记录规范构造器参数顺序一一对应。
            // Match SQL projection order to the record's canonical constructor parameters.
            var columns = tables.group(2).lines().toList();
            var components = type.getRecordComponents();
            var mappedColumns = metadata.getFieldList().stream().map(TableFieldInfo::getColumn).toList();
            assertEquals(columns.size(), components.length, table);
            assertEquals(columns.size(), mappedColumns.size(), table);
            for (int index = 0; index < columns.size(); index++) {
                // 保留完整列定义供检查空值及数值精度。
                // Keep the complete declaration to check nullability and numeric precision.
                String declaration = columns.get(index);
                var column = COLUMN.matcher(declaration);
                assertTrue(column.matches(), declaration);
                String name = column.group(1);
                var component = components[index];
                String context = table + "." + name;
                assertEquals(StringUtils.underlineToCamel(name), component.getName(), context);
                assertEquals(name, mappedColumns.get(index), context);
                var explicitColumn = type.getDeclaredField(component.getName()).getAnnotation(TableField.class);
                assertNotNull(explicitColumn, context);
                assertEquals(name, explicitColumn.value(), context);
                if (primaryKey.contains(name)) {
                    assertEquals(FieldStrategy.NEVER, explicitColumn.updateStrategy(), context);
                }
                assertEquals(javaType(column.group(2), declaration.contains("NOT NULL")), component.getType(), context);
            }
        } while (tables.find());
    }

    /**
     * 从模块、聚合工程或仓库根目录找到同一份 SQL 草案。
     * Locates the same SQL draft from the module, reactor or repository root.
     *
     * @return 存在时返回草案路径。 Draft path if present.
     */
    private static Optional<Path> findSchema() {
        // Maven 或 IDE 的工作目录可能位于仓库的不同层级。
        // Maven and IDE working directories may be at different levels in the checkout.
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve("docs/backend/schema.sql");
            if (Files.isRegularFile(candidate)) {
                return Optional.of(candidate);
            }
        }
        return Optional.empty();
    }

    /**
     * 将 SQL 列的精度和可空性转换为期望的 Java 类型。
     * Maps a SQL column's precision and nullability to its expected Java type.
     *
     * @param sqlType 包含精度的 PostgreSQL 类型。 PostgreSQL type including precision.
     * @param required 列是否具有非空约束。 Whether the column is declared NOT NULL.
     * @return 精确映射该列的 Java 类型。 Java type representing the column exactly.
     */
    private static Class<?> javaType(String sqlType, boolean required) {
        // scale=0 的两种精度均可能超出 long，健康度还必须保留其小数部分。
        // Both scale-zero precisions may exceed long, while health factors must retain the fractional part.
        if (sqlType.startsWith("varchar(")) {
            return String.class;
        }
        return switch (sqlType) {
            case "numeric(20,0)", "numeric(39,0)" -> BigInteger.class;
            case "numeric(51,12)" -> BigDecimal.class;
            case "timestamptz" -> OffsetDateTime.class;
            case "boolean" -> required ? boolean.class : Boolean.class;
            case "integer" -> required ? int.class : Integer.class;
            case "smallint" -> required ? short.class : Short.class;
            default -> throw new AssertionError("Unmapped PostgreSQL type " + sqlType);
        };
    }
}
