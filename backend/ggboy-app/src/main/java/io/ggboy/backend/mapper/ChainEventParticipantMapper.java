package io.ggboy.backend.mapper;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import io.ggboy.backend.entity.ChainEventKey;
import io.ggboy.backend.entity.ChainEventParticipantDO;
import org.apache.ibatis.annotations.Mapper;

import java.util.Collection;
import java.util.List;

/**
 * 通过 MyBatis-Plus 访问 {@code chain_event_participant} 中的事件参与方及其角色。
 * MyBatis-Plus mapper for event participants and their roles in {@code chain_event_participant}.
 */
@Mapper
public interface ChainEventParticipantMapper extends BaseMapper<ChainEventParticipantDO> {

    /**
     * 在本批交易内匹配指定钱包参与的事件，钱包担任多个角色时保留各角色行。
     * Finds events involving the wallet in this transaction batch, retaining rows for each role of the wallet.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param signatures 本批交易的 Base58 主签名集合。 Base58 primary signatures of the transaction batch.
     * @param wallet 拟匹配的钱包或 PDA 公钥。 Public key of the wallet or PDA to match.
     * @return 指定钱包在本批交易内的角色记录。 Role records of the requested wallet in the batch.
     */
    default List<ChainEventParticipantDO> selectForWallet(
            String network, Collection<String> signatures, String wallet
    ) {
        // 批次为空时不执行查询。网络和交易签名限制钱包检索范围。
        // Skip empty batches. Network and transaction signatures bound the wallet lookup.
        if (signatures.isEmpty()) {
            return List.of();
        }
        return selectList(Wrappers.lambdaQuery(ChainEventParticipantDO.class)
                .eq(ChainEventParticipantDO::getNetwork, network)
                .eq(ChainEventParticipantDO::getWalletAddress, wallet)
                .in(ChainEventParticipantDO::getSignature, signatures));
    }

    /**
     * 为本页每个业务事件加载完整参与方，包括未用于钱包筛选的其他钱包和角色。
     * Loads full participants for each event on the page, including wallets and roles unrelated to the wallet filter.
     *
     * @param network 已校验的网络协议值。 Validated network wire value.
     * @param keys 本页精确事件键列表。 Exact event keys selected for this page.
     * @return 匹配的参与方。同一事件内按钱包公钥和角色排序。 Matching participants ordered by wallet and role within an event.
     */
    default List<ChainEventParticipantDO> selectByEventKeys(String network, List<ChainEventKey> keys) {
        if (keys.isEmpty()) {
            return List.of();
        }
        // 在网络范围内按精确事件键读取参与方，角色记录不影响事先确定的页大小。
        // Read participants by exact event keys within the network. Role rows do not change the already selected page size.
        LambdaQueryWrapper<ChainEventParticipantDO> query = Wrappers.lambdaQuery(ChainEventParticipantDO.class)
                .eq(ChainEventParticipantDO::getNetwork, network);
        return selectList(ChainEventKeyConditions.forEvents(
                        query, ChainEventParticipantDO::getSignature, ChainEventParticipantDO::getEventIndex, keys)
                .orderByAsc(ChainEventParticipantDO::getWalletAddress)
                .orderByAsc(ChainEventParticipantDO::getRole));
    }
}
