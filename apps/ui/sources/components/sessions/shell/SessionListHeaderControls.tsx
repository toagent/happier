import React from 'react';
import { Animated, Easing, Platform, Pressable, View, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE } from './sessionListRowHeights';

const TAG_FILTER_ITEM_PREFIX = 'session-list-tag-filter:';
const SEARCH_INPUT_EXPANDED_WIDTH = 188;
const isNativeTouch = Platform.OS !== 'web';
// Collapsed, the shell is just the search button: on touch it is as wide as a finger target. The
// width is animated, so this has to be the animation's start value; a minWidth is not honored there.
const SEARCH_INPUT_COLLAPSED_WIDTH = isNativeTouch ? SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE : 16;
const SEARCH_SHELL_HEIGHT = 28;
const SEARCH_TRIGGER_NATIVE_TOUCH_VERTICAL_SLOP = (SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE - SEARCH_SHELL_HEIGHT) / 2;
const SEARCH_TRIGGER_NATIVE_TOUCH_HIT_SLOP = {
    top: SEARCH_TRIGGER_NATIVE_TOUCH_VERTICAL_SLOP,
    bottom: SEARCH_TRIGGER_NATIVE_TOUCH_VERTICAL_SLOP,
};
const SEARCH_INPUT_ANIMATION_MS = 170;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const WEB_NO_FOCUS_OUTLINE_STYLE = {
    outline: 'none',
    outlineStyle: 'none',
    outlineWidth: 0,
    outlineColor: 'transparent',
    boxShadow: 'none',
} as unknown as ViewStyle;
const SEARCH_INPUT_CHROME_RESET_STYLE = {
    outline: 'none',
    outlineStyle: 'none',
    outlineWidth: 0,
    outlineColor: 'transparent',
    outlineOffset: 0,
    boxShadow: 'none',
    borderWidth: 0,
    borderColor: 'transparent',
    backgroundColor: 'transparent',
    appearance: 'none',
    WebkitAppearance: 'none',
} as unknown as TextStyle;

const stylesheet = StyleSheet.create((theme) => ({
    controls: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 8,
    },
    // On touch the buttons below carry their own finger-sized boxes, so the row needs no extra gap.
    controlsNativeTouch: {
        gap: 0,
    },
    iconButton: {
        width: 20,
        height: 24,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    iconButtonNativeTouch: {
        width: SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE,
        height: SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE,
    },
    searchShell: {
        position: 'relative' as const,
        height: SEARCH_SHELL_HEIGHT,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        overflow: 'visible' as const,
    },
    searchShellCollapsed: {
        width: SEARCH_INPUT_COLLAPSED_WIDTH,
    },
    searchShellExpanded: {
        borderRadius: 7,
        justifyContent: 'flex-start' as const,
        paddingLeft: 6,
        paddingRight: 8,
        gap: 5,
        zIndex: 2,
    },
    searchShellBackdrop: {
        position: 'absolute' as const,
        top: -3,
        right: -3,
        bottom: -3,
        left: -3,
        borderRadius: 10,
        backgroundColor: theme.colors.background.canvas,
        shadowColor: theme.colors.background.canvas,
        shadowOpacity: 1,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        boxShadow: `0 0 0 3px ${theme.colors.background.canvas}, 0 4px 12px ${theme.colors.background.canvas}`,
        zIndex: 0,
    },
    searchShellBorder: {
        position: 'absolute' as const,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        zIndex: 1,
    },
    searchIcon: {
        position: 'relative' as const,
        zIndex: 2,
    },
    searchInputContainer: {
        position: 'relative' as const,
        zIndex: 2,
        flex: 1,
        minWidth: 0,
    },
    searchTrailingAccessory: {
        position: 'relative' as const,
        zIndex: 2,
        width: 18,
        height: 20,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        flexShrink: 0,
    },
    searchClearButton: {
        width: 18,
        height: 20,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    searchInput: {
        flex: 1,
        minWidth: 0,
        height: 20,
        lineHeight: 20,
        padding: 0,
        margin: 0,
        color: theme.colors.text.primary,
    },
}));

function stopPressEventPropagation(event: unknown): void {
    if (!event || typeof event !== 'object' || !('stopPropagation' in event)) return;
    const stopPropagation = (event as { stopPropagation?: () => void }).stopPropagation;
    if (typeof stopPropagation === 'function') {
        (event as { stopPropagation: () => void }).stopPropagation();
    }
}

function resolveTagFromItemId(itemId: string): string | null {
    if (!itemId.startsWith(TAG_FILTER_ITEM_PREFIX)) return null;
    const tag = itemId.slice(TAG_FILTER_ITEM_PREFIX.length);
    return tag.length > 0 ? tag : null;
}

export const SessionListHeaderControls = React.memo(function SessionListHeaderControls(props: Readonly<{
    allKnownTags: ReadonlyArray<string>;
    selectedTags: ReadonlyArray<string>;
    searchQuery: string;
    searchOpen?: boolean;
    onSelectedTagsChange: (tags: string[]) => void;
    onSearchQueryChange: (query: string) => void;
    onSearchFocusChange?: (focused: boolean) => void;
    searchTrailingAccessory?: React.ReactNode;
    viewMenu: React.ReactNode;
}>) {
    const {
        allKnownTags,
        onSearchQueryChange,
        onSelectedTagsChange,
        searchQuery,
        searchOpen = false,
        selectedTags,
        onSearchFocusChange,
        searchTrailingAccessory,
        viewMenu,
    } = props;
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const inputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
    const searchAnimation = React.useRef(new Animated.Value(searchQuery.trim().length > 0 ? 1 : 0)).current;
    const [searchFocused, setSearchFocused] = React.useState(false);
    // Keep a local input echo so native TextInput receives the typed value synchronously even if the virtualized header prop lags.
    const [searchInputValue, setSearchInputValue] = React.useState(searchQuery);
    const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
    const iconColor = theme.colors.text.secondary;
    const activeIconColor = theme.colors.accent.blue;
    const searchIsOpen = searchOpen || searchFocused || searchInputValue.trim().length > 0;
    const searchHasQuery = searchInputValue.trim().length > 0;
    const searchTrailingAccessoryHasContent = React.Children.count(searchTrailingAccessory) > 0;
    const showSearchClearButton = searchIsOpen && searchHasQuery && !searchTrailingAccessoryHasContent;
    const shouldRenderSearchTrailingSlot = searchIsOpen && (
        searchTrailingAccessory !== undefined || showSearchClearButton
    );
    const selectedTagSet = React.useMemo(() => new Set(selectedTags), [selectedTags]);

    React.useEffect(() => {
        setSearchInputValue(searchQuery);
    }, [searchQuery]);

    React.useEffect(() => {
        if (!searchIsOpen) return;
        inputRef.current?.focus?.();
    }, [searchIsOpen]);

    React.useEffect(() => {
        Animated.timing(searchAnimation, {
            toValue: searchIsOpen ? 1 : 0,
            duration: SEARCH_INPUT_ANIMATION_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: false,
        }).start();
    }, [searchAnimation, searchIsOpen]);

    const animatedSearchShellStyle = React.useMemo(() => ({
        width: searchAnimation.interpolate({
            inputRange: [0, 1],
            outputRange: [SEARCH_INPUT_COLLAPSED_WIDTH, SEARCH_INPUT_EXPANDED_WIDTH],
        }),
    }), [searchAnimation]);
    const animatedSearchChromeStyle = React.useMemo(() => ({
        opacity: searchAnimation,
    }), [searchAnimation]);

    const handleOpenSearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        onSearchFocusChange?.(true);
        setSearchFocused(true);
    }, [onSearchFocusChange]);

    const handleSearchBlur = React.useCallback(() => {
        onSearchFocusChange?.(false);
        setSearchFocused(false);
    }, [onSearchFocusChange]);

    const handleSearchFocus = React.useCallback(() => {
        onSearchFocusChange?.(true);
        setSearchFocused(true);
    }, [onSearchFocusChange]);

    const handleSearchQueryChange = React.useCallback((query: string) => {
        setSearchInputValue(query);
        onSearchQueryChange(query);
    }, [onSearchQueryChange]);

    const handleSearchKeyPress = React.useCallback((event: { nativeEvent?: { key?: string } }) => {
        if (event.nativeEvent?.key !== 'Escape') return;
        setSearchInputValue('');
        onSearchQueryChange('');
        onSearchFocusChange?.(false);
        setSearchFocused(false);
    }, [onSearchFocusChange, onSearchQueryChange]);

    const handleClearSearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        setSearchInputValue('');
        onSearchQueryChange('');
        onSearchFocusChange?.(true);
        setSearchFocused(true);
        inputRef.current?.focus?.();
    }, [onSearchFocusChange, onSearchQueryChange]);

    const tagItems = React.useMemo((): DropdownMenuItem[] => allKnownTags.map((tag) => {
        const selected = selectedTagSet.has(tag);
        return {
            id: `${TAG_FILTER_ITEM_PREFIX}${tag}`,
            title: tag,
            icon: <Icon name="tag" size={14} color={selected ? activeIconColor : iconColor} />,
            rightElement: selected
                ? <Icon name="check" size={14} color={activeIconColor} />
                : null,
        };
    }), [activeIconColor, allKnownTags, iconColor, selectedTagSet]);

    const handleTagSelect = React.useCallback((itemId: string) => {
        const tag = resolveTagFromItemId(itemId);
        if (!tag) return;
        const nextTags = selectedTagSet.has(tag)
            ? selectedTags.filter((item) => item !== tag)
            : [...selectedTags, tag];
        onSelectedTagsChange(nextTags);
    }, [onSelectedTagsChange, selectedTagSet, selectedTags]);

    return (
        <View style={isNativeTouch ? [styles.controls, styles.controlsNativeTouch] : styles.controls}>
            <AnimatedPressable
                testID="session-list-search-trigger"
                accessibilityRole={searchIsOpen ? undefined : 'button'}
                accessibilityLabel={searchIsOpen ? undefined : t('sessionsList.searchSessions')}
                onPress={searchIsOpen ? undefined : handleOpenSearch}
                // The shell keeps its compact 28px pill when expanded, so on touch the collapsed
                // trigger reaches finger height through vertical hitSlop instead of a taller box.
                hitSlop={searchIsOpen ? undefined : isNativeTouch ? SEARCH_TRIGGER_NATIVE_TOUCH_HIT_SLOP : 8}
                style={[
                    styles.searchShell,
                    WEB_NO_FOCUS_OUTLINE_STYLE,
                    animatedSearchShellStyle,
                    searchIsOpen ? styles.searchShellExpanded : null,
                ]}
            >
                <Animated.View
                    pointerEvents="none"
                    style={[styles.searchShellBackdrop, animatedSearchChromeStyle]}
                />
                <Animated.View
                    pointerEvents="none"
                    style={[styles.searchShellBorder, animatedSearchChromeStyle]}
                />
                <Icon
                    name="magnifying-glass"
                    size={16}
                    color={searchIsOpen ? activeIconColor : iconColor}
                    style={styles.searchIcon}
                />
                {searchIsOpen ? (
                    <View style={styles.searchInputContainer}>
                        <TextInput
                            ref={inputRef}
                            testID="session-list-search-input"
                            accessibilityLabel={t('sessionsList.searchSessions')}
                            placeholder={t('sessionsList.searchSessionsPlaceholder')}
                            placeholderTextColor={theme.colors.text.tertiary}
                            value={searchInputValue}
                            onChangeText={handleSearchQueryChange}
                            onFocus={handleSearchFocus}
                            onBlur={handleSearchBlur}
                            onKeyPress={handleSearchKeyPress}
                            autoFocus={true}
                            returnKeyType="search"
                            autoCorrect={false}
                            style={[styles.searchInput, SEARCH_INPUT_CHROME_RESET_STYLE]}
                        />
                    </View>
                ) : null}
                {shouldRenderSearchTrailingSlot ? (
                    <View
                        testID="session-list-search-trailing-accessory"
                        pointerEvents={showSearchClearButton ? 'auto' : 'none'}
                        accessibilityElementsHidden={showSearchClearButton ? undefined : true}
                        importantForAccessibility={showSearchClearButton ? undefined : 'no-hide-descendants'}
                        style={styles.searchTrailingAccessory}
                    >
                        {showSearchClearButton ? (
                            <Pressable
                                testID="session-list-search-clear"
                                accessibilityRole="button"
                                accessibilityLabel={t('common.clearSearch')}
                                onPress={handleClearSearch}
                                hitSlop={10}
                                style={styles.searchClearButton}
                            >
                                <Icon
                                    name="x-circle"
                                    size={14}
                                    color={theme.colors.text.tertiary}
                                />
                            </Pressable>
                        ) : searchTrailingAccessory}
                    </View>
                ) : null}
            </AnimatedPressable>
            {allKnownTags.length > 0 ? (
                <DropdownMenu
                    open={tagMenuOpen}
                    onOpenChange={setTagMenuOpen}
                    items={tagItems}
                    onSelect={handleTagSelect}
                    selectedId={selectedTags[0] ?? null}
                    placement="left"
                    variant="slim"
                    search={allKnownTags.length > 8}
                    searchPlaceholder={t('sessionTags.searchOrAddPlaceholder')}
                    closeOnSelect={false}
                    matchTriggerWidth={false}
                    maxWidthCap={220}
                    showCategoryTitles={false}
                    popoverPortalWebTarget="body"
                    trigger={({ toggle }) => (
                        <Pressable
                            testID="session-list-tag-filter-trigger"
                            accessibilityRole="button"
                            accessibilityLabel={t('sessionsList.filterByTags')}
                            onPress={(event) => {
                                stopPressEventPropagation(event);
                                toggle();
                            }}
                            hitSlop={isNativeTouch ? undefined : 8}
                            style={isNativeTouch ? [styles.iconButton, styles.iconButtonNativeTouch] : styles.iconButton}
                        >
                            <Icon
                                name="tag"
                                size={16}
                                color={selectedTags.length > 0 ? activeIconColor : iconColor}
                            />
                        </Pressable>
                    )}
                />
            ) : null}
            {viewMenu}
        </View>
    );
});
