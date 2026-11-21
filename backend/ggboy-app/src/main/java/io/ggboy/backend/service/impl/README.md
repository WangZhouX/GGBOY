# 基础服务实现

本包中的 `XxxServiceImpl` 使用 Spring `@Service` 注册，继承 `ServiceImpl<XxxMapper, XxxDO>`，并实现对应的 [XxxService 接口](../README.md)。基类注入与泛型匹配的 [Mapper](../../mapper/README.md)。例如 [VaultServiceImpl](VaultServiceImpl.java) 将 `VaultService` 绑定到 `VaultMapper` 和 `VaultDO`。
