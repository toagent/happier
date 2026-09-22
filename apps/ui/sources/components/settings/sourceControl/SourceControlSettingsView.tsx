import React from 'react';
import { Platform, View } from 'react-native';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { scmBackendSettingsRegistry } from '@/scm/settings/scmBackendSettingsRegistry';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { Modal } from '@/modal';
import { t, type TranslationKey } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/ui/forms/Switch';
import type {
    ScmGitRepoPreferredBackend,
    ScmPushRejectPolicy,
    ScmRemoteConfirmPolicy,
} from '@/scm/settings/preferences';
import {
    setRemoteConfirmationForKind,
    shouldConfirmRemoteOperation,
} from '@/scm/settings/remoteConfirmationPolicy';
import { TextInput } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { CodeServerReviewSettings } from './CodeServerReviewSettings';


type IoniconName = IconName;

const COMMIT_STRATEGY_OPTIONS: ReadonlyArray<{
    id: ScmCommitStrategy;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'atomic',
        titleKey: 'settingsSourceControl.commitStrategy.options.atomic.title',
        subtitleKey: 'settingsSourceControl.commitStrategy.options.atomic.subtitle',
        iconName: 'shield-check',
    },
    {
        id: 'git_staging',
        titleKey: 'settingsSourceControl.commitStrategy.options.gitStaging.title',
        subtitleKey: 'settingsSourceControl.commitStrategy.options.gitStaging.subtitle',
        iconName: 'git-diff',
    },
];

const GIT_REPO_BACKEND_OPTIONS: ReadonlyArray<{
    id: ScmGitRepoPreferredBackend;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'git',
        titleKey: 'settingsSourceControl.gitRoutingPreference.options.git.title',
        subtitleKey: 'settingsSourceControl.gitRoutingPreference.options.git.subtitle',
        iconName: 'github-logo',
    },
    {
        id: 'sapling',
        titleKey: 'settingsSourceControl.gitRoutingPreference.options.sapling.title',
        subtitleKey: 'settingsSourceControl.gitRoutingPreference.options.sapling.subtitle',
        iconName: 'git-branch',
    },
];

const PUSH_REJECT_OPTIONS: ReadonlyArray<{
    id: ScmPushRejectPolicy;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'prompt_fetch',
        titleKey: 'settingsSourceControl.pushRejectionRecovery.options.promptFetch.title',
        subtitleKey: 'settingsSourceControl.pushRejectionRecovery.options.promptFetch.subtitle',
        iconName: 'lifebuoy',
    },
    {
        id: 'auto_fetch',
        titleKey: 'settingsSourceControl.pushRejectionRecovery.options.autoFetch.title',
        subtitleKey: 'settingsSourceControl.pushRejectionRecovery.options.autoFetch.subtitle',
        iconName: 'arrows-clockwise',
    },
    {
        id: 'manual',
        titleKey: 'settingsSourceControl.pushRejectionRecovery.options.manual.title',
        subtitleKey: 'settingsSourceControl.pushRejectionRecovery.options.manual.subtitle',
        iconName: 'hand',
    },
];

const DIFF_MODE_OPTIONS: ReadonlyArray<{
    id: ScmDiffArea;
    titleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    { id: 'pending', titleKey: 'settingsSourceControl.diffMode.pending', iconName: 'clock' },
    { id: 'both', titleKey: 'settingsSourceControl.diffMode.combined', iconName: 'git-merge' },
    { id: 'included', titleKey: 'settingsSourceControl.diffMode.included', iconName: 'check-circle' },
];

const FILES_SYNTAX_HIGHLIGHTING_OPTIONS: ReadonlyArray<{
    id: 'off' | 'simple' | 'advanced';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'off',
        titleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.off.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.off.subtitle',
        iconName: 'text-aa',
    },
    {
        id: 'simple',
        titleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.subtitle',
        iconName: 'palette',
    },
    {
        id: 'advanced',
        titleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.advanced.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.advanced.subtitle',
        iconName: 'sparkle',
    },
];

const FILES_DIFF_RENDERER_OPTIONS: ReadonlyArray<{
    id: 'pierre' | 'happier';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'pierre',
        titleKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.pierre.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.pierre.subtitle',
        iconName: 'sparkle',
    },
    {
        id: 'happier',
        titleKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.happier.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.happier.subtitle',
        iconName: 'code',
    },
];

const FILES_DIFF_PRESENTATION_OPTIONS: ReadonlyArray<{
    id: 'unified' | 'split';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'unified',
        titleKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.subtitle',
        iconName: 'arrows-down-up',
    },
    {
        id: 'split',
        titleKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.split.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.split.subtitle',
        iconName: 'grid-four',
    },
];

const FILES_CHANGED_FILES_DENSITY_OPTIONS: ReadonlyArray<{
    id: 'comfortable' | 'compact';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'comfortable',
        titleKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.comfortable.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.comfortable.subtitle',
        iconName: 'list',
    },
    {
        id: 'compact',
        titleKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.subtitle',
        iconName: 'list',
    },
];

const MARKDOWN_EDIT_MODE_OPTIONS: ReadonlyArray<{
    id: 'rich' | 'raw';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'rich',
        titleKey: 'settingsSourceControl.markdownEditMode.options.rich.title',
        subtitleKey: 'settingsSourceControl.markdownEditMode.options.rich.subtitle',
        iconName: 'file-text',
    },
    {
        id: 'raw',
        titleKey: 'settingsSourceControl.markdownEditMode.options.raw.title',
        subtitleKey: 'settingsSourceControl.markdownEditMode.options.raw.subtitle',
        iconName: 'code',
    },
];

export const SourceControlSettingsView = React.memo(function SourceControlSettingsView() {
    const { theme } = useUnistyles();
    const [scmCommitStrategy, setScmCommitStrategy] = useSettingMutable('scmCommitStrategy');
    const [scmGitRepoPreferredBackend, setScmGitRepoPreferredBackend] = useSettingMutable('scmGitRepoPreferredBackend');
    const [scmRemoteConfirmPolicy, setScmRemoteConfirmPolicy] = useSettingMutable('scmRemoteConfirmPolicy');
    const [scmPushRejectPolicy, setScmPushRejectPolicy] = useSettingMutable('scmPushRejectPolicy');
    const [scmDefaultDiffModeByBackend, setScmDefaultDiffModeByBackend] = useSettingMutable('scmDefaultDiffModeByBackend');
    const [filesDiffSyntaxHighlightingMode, setFilesDiffSyntaxHighlightingMode] = useSettingMutable('filesDiffSyntaxHighlightingMode');
    const [filesDiffRendererMode, setFilesDiffRendererMode] = useSettingMutable('filesDiffRendererMode');
    const [filesDiffPresentationStyle, setFilesDiffPresentationStyle] = useSettingMutable('filesDiffPresentationStyle');
    const [filesChangedFilesRowDensity, setFilesChangedFilesRowDensity] = useSettingMutable('filesChangedFilesRowDensity');
    const [scmCommitMessageGeneratorEnabled, setScmCommitMessageGeneratorEnabled] = useSettingMutable('scmCommitMessageGeneratorEnabled');
    const [scmCommitMessageGeneratorBackendId, setScmCommitMessageGeneratorBackendId] = useSettingMutable('scmCommitMessageGeneratorBackendId');
    const [scmCommitMessageGeneratorInstructions, setScmCommitMessageGeneratorInstructions] = useSettingMutable('scmCommitMessageGeneratorInstructions');
    const [scmIncludeCoAuthoredBy, setScmIncludeCoAuthoredBy] = useSettingMutable('scmIncludeCoAuthoredBy');
    const [filesEditorAutoSave, setFilesEditorAutoSave] = useSettingMutable('filesEditorAutoSave');
    const [markdownDefaultEditMode, setMarkdownDefaultEditMode] = useSettingMutable('markdownDefaultEditMode');
    const markdownRichEditorEnabled = useFeatureEnabled('files.markdownRichEditor');
    const backendPlugins = scmBackendSettingsRegistry.listPlugins();
    const currentDiffModeByBackend = scmDefaultDiffModeByBackend ?? {};
    const effectiveRemoteConfirmPolicy: ScmRemoteConfirmPolicy =
        scmRemoteConfirmPolicy === 'pull_only'
        || scmRemoteConfirmPolicy === 'push_only'
        || scmRemoteConfirmPolicy === 'never'
        || scmRemoteConfirmPolicy === 'always'
            ? scmRemoteConfirmPolicy
            : 'always';
    const effectiveFilesDiffSyntaxHighlightingMode = (filesDiffSyntaxHighlightingMode ?? 'off') as 'off' | 'simple' | 'advanced';
    const effectiveFilesDiffRendererMode = filesDiffRendererMode === 'happier' ? 'happier' : 'pierre';
    const effectiveFilesDiffPresentationStyle = filesDiffPresentationStyle === 'unified' || filesDiffPresentationStyle === 'split'
        ? filesDiffPresentationStyle
        : (settingsDefaults.filesDiffPresentationStyle === 'split' ? 'split' : 'unified');
    const effectiveFilesChangedFilesRowDensity = filesChangedFilesRowDensity === 'compact' ? 'compact' : 'comfortable';
    const effectiveMarkdownDefaultEditMode = markdownDefaultEditMode === 'raw' ? 'raw' : 'rich';
    const effectiveCommitMessageGeneratorEnabled = scmCommitMessageGeneratorEnabled === true;
    const effectiveCommitMessageGeneratorBackendId = typeof scmCommitMessageGeneratorBackendId === 'string' && scmCommitMessageGeneratorBackendId.trim()
        ? scmCommitMessageGeneratorBackendId.trim()
        : DEFAULT_AGENT_ID;
    const effectiveCommitMessageGeneratorInstructions = typeof scmCommitMessageGeneratorInstructions === 'string'
        ? scmCommitMessageGeneratorInstructions
        : '';
    const effectiveIncludeCoAuthoredBy = scmIncludeCoAuthoredBy === true;

    const renderIcon = React.useCallback((iconName: IoniconName) => (
        <Icon name={iconName} size={29} color={theme.colors.text.secondary} />
    ), [theme.colors.text.secondary]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <CodeServerReviewSettings />
            <ItemGroup
                title={t('settingsSourceControl.commitStrategy.title')}
                footer={t('settingsSourceControl.commitStrategy.footer')}
            >
                {COMMIT_STRATEGY_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmCommitStrategy === option.id ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setScmCommitStrategy(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.gitRoutingPreference.title')}
                footer={t('settingsSourceControl.gitRoutingPreference.footer')}
            >
                {GIT_REPO_BACKEND_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmGitRepoPreferredBackend === option.id ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setScmGitRepoPreferredBackend(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.remoteConfirmation.title')}
                footer={t('settingsSourceControl.remoteConfirmation.footer')}
            >
                <Item
                    title={t('settingsSourceControl.remoteConfirmation.pull.title')}
                    subtitle={t('settingsSourceControl.remoteConfirmation.pull.subtitle')}
                    icon={renderIcon('arrow-circle-down')}
                    rightElement={(
                        <Switch
                            value={shouldConfirmRemoteOperation(effectiveRemoteConfirmPolicy, 'pull')}
                            onValueChange={(enabled) => setScmRemoteConfirmPolicy(
                                setRemoteConfirmationForKind(effectiveRemoteConfirmPolicy, 'pull', enabled),
                            )}
                        />
                    )}
                    onPress={() => setScmRemoteConfirmPolicy(
                        setRemoteConfirmationForKind(
                            effectiveRemoteConfirmPolicy,
                            'pull',
                            !shouldConfirmRemoteOperation(effectiveRemoteConfirmPolicy, 'pull'),
                        ),
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsSourceControl.remoteConfirmation.push.title')}
                    subtitle={t('settingsSourceControl.remoteConfirmation.push.subtitle')}
                    icon={renderIcon('arrow-circle-up')}
                    rightElement={(
                        <Switch
                            value={shouldConfirmRemoteOperation(effectiveRemoteConfirmPolicy, 'push')}
                            onValueChange={(enabled) => setScmRemoteConfirmPolicy(
                                setRemoteConfirmationForKind(effectiveRemoteConfirmPolicy, 'push', enabled),
                            )}
                        />
                    )}
                    onPress={() => setScmRemoteConfirmPolicy(
                        setRemoteConfirmationForKind(
                            effectiveRemoteConfirmPolicy,
                            'push',
                            !shouldConfirmRemoteOperation(effectiveRemoteConfirmPolicy, 'push'),
                        ),
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.pushRejectionRecovery.title')}
                footer={t('settingsSourceControl.pushRejectionRecovery.footer')}
            >
                {PUSH_REJECT_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmPushRejectPolicy === option.id ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setScmPushRejectPolicy(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.commitMessageGenerator.title')}
                footer={t('settingsSourceControl.commitMessageGenerator.footer')}
            >
                <Item
                    title={t('settingsSourceControl.commitMessageGenerator.title')}
                    subtitle={effectiveCommitMessageGeneratorEnabled ? t('common.enabled') : t('common.disabled')}
                    icon={renderIcon('sparkle')}
                    rightElement={effectiveCommitMessageGeneratorEnabled ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                    onPress={() => setScmCommitMessageGeneratorEnabled(!effectiveCommitMessageGeneratorEnabled)}
                    showChevron={false}
                />
                <Item
                    title={t('settingsSourceControl.commitMessageGenerator.backendItemTitle', { backendId: effectiveCommitMessageGeneratorBackendId })}
                    subtitle={t('settingsSourceControl.commitMessageGenerator.backendItemSubtitle')}
                    icon={renderIcon('hard-drives')}
                    onPress={async () => {
                        const next = await Modal.prompt(t('settingsSourceControl.commitMessageGenerator.backendPromptTitle'), t('settingsSourceControl.commitMessageGenerator.backendPromptMessage'), {
                            defaultValue: effectiveCommitMessageGeneratorBackendId,
                            placeholder: DEFAULT_AGENT_ID,
                            confirmText: t('common.save'),
                            cancelText: t('common.cancel'),
                        });
                        if (typeof next === 'string' && next.trim()) {
                            setScmCommitMessageGeneratorBackendId(next.trim());
                        }
                    }}
                    showChevron={false}
                />

                <View style={{ paddingHorizontal: 16, paddingTop: 0, gap: 6 }}>
                      <TextInput
                        style={{
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            borderRadius: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            height: 110,
                            textAlignVertical: 'top' as any,
                            color: theme.colors.text.primary,
                        }}
                        placeholder={t('settingsSourceControl.commitMessageGenerator.instructionsPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={effectiveCommitMessageGeneratorInstructions}
                        multiline={true}
                        onChangeText={(value) => setScmCommitMessageGeneratorInstructions(String(value))}
                    />
                </View>
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.commitAttribution.title')}
                footer={t('settingsSourceControl.commitAttribution.footer')}
            >
                <Item
                    title={t('settingsSourceControl.commitAttribution.includeCoAuthoredBy.title')}
                    subtitle={effectiveIncludeCoAuthoredBy ? t('common.enabled') : t('common.disabled')}
                    icon={renderIcon('users')}
                    rightElement={effectiveIncludeCoAuthoredBy ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                    onPress={() => setScmIncludeCoAuthoredBy(!effectiveIncludeCoAuthoredBy)}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.filesDisplay.title')}
                footer={t('settingsSourceControl.filesDisplay.footer')}
            >
                {(Platform.OS === 'web' || String(Platform.OS) === 'node') ? (
                    <>
                        {FILES_DIFF_RENDERER_OPTIONS.map((option) => (
                            <Item
                                key={option.id}
                                title={t(option.titleKey)}
                                subtitle={t(option.subtitleKey)}
                                icon={renderIcon(option.iconName)}
                                rightElement={effectiveFilesDiffRendererMode === option.id ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                                onPress={() => setFilesDiffRendererMode(option.id)}
                                showChevron={false}
                            />
                        ))}
                        {effectiveFilesDiffRendererMode === 'pierre' ? (
                            <>
                                {FILES_DIFF_PRESENTATION_OPTIONS.map((option) => (
                                    <Item
                                        key={option.id}
                                        title={t(option.titleKey)}
                                        subtitle={t(option.subtitleKey)}
                                        icon={renderIcon(option.iconName)}
                                        rightElement={effectiveFilesDiffPresentationStyle === option.id ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                                        onPress={() => setFilesDiffPresentationStyle(option.id)}
                                        showChevron={false}
                                    />
                                ))}
                            </>
                        ) : null}
                    </>
                ) : null}
                {FILES_SYNTAX_HIGHLIGHTING_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveFilesDiffSyntaxHighlightingMode === option.id ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setFilesDiffSyntaxHighlightingMode(option.id)}
                        showChevron={false}
                    />
                ))}
                {FILES_CHANGED_FILES_DENSITY_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveFilesChangedFilesRowDensity === option.id ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setFilesChangedFilesRowDensity(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {backendPlugins.map((plugin) => (
                <ItemGroup key={plugin.backendId} title={t('settingsSourceControl.backends.backendGroupTitle', { backendTitle: plugin.title })} footer={plugin.description}>
                    {(() => {
                        const backendUiPlugin = scmUiBackendRegistry.getPlugin(plugin.backendId);
                        const availableModes = backendUiPlugin.diffModeConfig(null).availableModes;
                        return DIFF_MODE_OPTIONS
                            .filter((option) => availableModes.includes(option.id))
                            .map((option) => (
                                <Item
                                    key={`diff-${plugin.backendId}-${option.id}`}
                                    title={t('settingsSourceControl.backends.defaultDiffItemTitle', { backendTitle: plugin.title, diffModeTitle: t(option.titleKey) })}
                                    subtitle={t('settingsSourceControl.backends.defaultDiffItemSubtitle')}
                                    icon={renderIcon(option.iconName)}
                                    rightElement={
                                        currentDiffModeByBackend[plugin.backendId] === option.id
                                            ? <Icon name="check" size={20} color={theme.colors.accent.blue} />
                                            : null
                                    }
                                    onPress={() => {
                                        setScmDefaultDiffModeByBackend({
                                            ...currentDiffModeByBackend,
                                            [plugin.backendId]: option.id,
                                        });
                                    }}
                                    showChevron={false}
                                />
                            ));
                    })()}
                    {plugin.infoItems.map((item) => (
                        <Item
                            key={item.id}
                            title={item.title}
                            subtitle={item.subtitle}
                            icon={renderIcon(item.iconName)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ))}
            {/* Editor */}
            <ItemGroup title={t('settingsSourceControl.editor')} footer={t('settingsSourceControl.editorFooter')}>
                <Item
                    title={t('settingsSourceControl.editorAutoSave')}
                    subtitle={t('settingsSourceControl.editorAutoSaveDescription')}
                    icon={<Icon name="floppy-disk" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={filesEditorAutoSave === true}
                            onValueChange={setFilesEditorAutoSave}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>
            {markdownRichEditorEnabled ? (
                <ItemGroup
                    title={t('settingsSourceControl.markdownEditMode.title')}
                    footer={t('settingsSourceControl.markdownEditMode.footer')}
                >
                    {MARKDOWN_EDIT_MODE_OPTIONS.map((option) => (
                        <Item
                            key={option.id}
                            title={t(option.titleKey)}
                            subtitle={t(option.subtitleKey)}
                            icon={renderIcon(option.iconName)}
                            rightElement={effectiveMarkdownDefaultEditMode === option.id ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                            onPress={() => setMarkdownDefaultEditMode(option.id)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
