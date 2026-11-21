package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import io.ggboy.backend.entity.ChainEventAssetDO;
import io.ggboy.backend.entity.ChainEventKey;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

/**
 * 通过 MyBatis-Plus 访问 {@code chain_event_asset} 中事件实际发生的代币变动。
 * MyBatis-Plus mapper for actual token movements of a business event in {@code chain_event_asset}.
 */
@Mapper
public interface ChainEventAssetMapper extends BaseMapper<ChainEventAssetDO> {

    /**
     * 为本页业务事件加载所有资产变动。各事件内按资产变动序号升序。
     * Loads all asset movements of events on this page in ascending leg index order within each event.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param keys 本页精确事件键列表。 Exact event keys selected for this page.
     * @return 该批事件的资产变动明细。 Asset movement details for the selected events.
     */
    default List<ChainEventAssetDO> selectByEventKeys(String network, List<ChainEventKey> keys) {
        if (keys.isEmpty()) {
            return List.of();
        }
        // 与参与方沿用相同的复合键匹配方式，使明细只属于本页已确定的事件。
        // Use the same composite key matching as participants so every detail belongs to an event selected for this page.
        LambdaQueryWrapper<ChainEventAssetDO> query = Wrappers.lambdaQuery(ChainEventAssetDO.class)
                .eq(ChainEventAssetDO::getNetwork, network);
        return selectList(ChainEventKeyConditions.forEvents(
                        query, ChainEventAssetDO::getSignature, ChainEventAssetDO::getEventIndex, keys)
                .orderByAsc(ChainEventAssetDO::getLegIndex));
    }
}
