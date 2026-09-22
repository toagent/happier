import React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Modal } from '@/modal';
import { useMachineListByServerId, useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { isCanonicalAbsoluteDirectory, isValidCodeServerReviewBaseUrl } from '@/utils/url/codeServerReviewUrl';
import { useUnistyles } from 'react-native-unistyles';

export const CodeServerReviewSettings = React.memo(function CodeServerReviewSettings() {
    const { theme } = useUnistyles();
    const [codeServerReviewTarget, setCodeServerReviewTarget] = useSettingMutable('codeServerReviewTargetV1');
    const activeServerId = useActiveServerSnapshot().serverId;
    const machines = useMachineListByServerId()[activeServerId] ?? [];
    const renderIcon = (name: 'hard-drives' | 'link' | 'folder' | 'x') => (
        <Icon name={name} size={29} color={theme.colors.text.secondary} />
    );

    return (
        <ItemGroup title={t('settingsSourceControl.codeServer.title')} footer={t('settingsSourceControl.codeServer.footer')}>
            {machines.filter((machine) => !machine.revokedAt).map((machine) => (
                <Item
                    key={machine.id}
                    title={machine.metadata?.displayName || machine.metadata?.host || machine.id}
                    subtitle={t('settingsSourceControl.codeServer.machine')}
                    icon={renderIcon('hard-drives')}
                    rightElement={codeServerReviewTarget?.serverId === activeServerId && codeServerReviewTarget.machineId === machine.id
                        ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                    onPress={() => setCodeServerReviewTarget({
                        serverId: activeServerId,
                        machineId: machine.id,
                        baseUrl: codeServerReviewTarget?.baseUrl ?? '',
                        rootPath: codeServerReviewTarget?.rootPath ?? '',
                    })}
                    showChevron={false}
                />
            ))}
            {codeServerReviewTarget ? <>
                <Item
                    title={t('settingsSourceControl.codeServer.url')}
                    subtitle={codeServerReviewTarget.baseUrl || t('settingsSourceControl.codeServer.unset')}
                    icon={renderIcon('link')}
                    onPress={async () => {
                        const next = await Modal.prompt(t('settingsSourceControl.codeServer.url'), '', {
                            defaultValue: codeServerReviewTarget.baseUrl,
                            placeholder: 'https://review.example.com/',
                            confirmText: t('common.save'), cancelText: t('common.cancel'),
                        });
                        if (typeof next !== 'string') return;
                        if (!isValidCodeServerReviewBaseUrl(next.trim())) {
                            Modal.alert(t('common.error'), t('settingsSourceControl.codeServer.invalidUrl'));
                            return;
                        }
                        setCodeServerReviewTarget({ ...codeServerReviewTarget, baseUrl: next.trim() });
                    }}
                />
                <Item
                    title={t('settingsSourceControl.codeServer.root')}
                    subtitle={codeServerReviewTarget.rootPath || t('settingsSourceControl.codeServer.unset')}
                    icon={renderIcon('folder')}
                    onPress={async () => {
                        const next = await Modal.prompt(t('settingsSourceControl.codeServer.root'), '', {
                            defaultValue: codeServerReviewTarget.rootPath,
                            confirmText: t('common.save'), cancelText: t('common.cancel'),
                        });
                        if (typeof next !== 'string') return;
                        const rootPath = next.trim().replace(/\/+$/u, '');
                        if (!isCanonicalAbsoluteDirectory(rootPath)) {
                            Modal.alert(t('common.error'), t('settingsSourceControl.codeServer.invalidRoot'));
                            return;
                        }
                        setCodeServerReviewTarget({ ...codeServerReviewTarget, rootPath });
                    }}
                />
                <Item
                    title={t('settingsSourceControl.codeServer.remove')}
                    icon={renderIcon('x')}
                    onPress={() => setCodeServerReviewTarget(null)}
                    showChevron={false}
                />
            </> : null}
        </ItemGroup>
    );
});
