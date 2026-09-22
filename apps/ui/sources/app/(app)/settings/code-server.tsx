import { CodeServerReviewSettings } from '@/components/settings/sourceControl/CodeServerReviewSettings';
import { ItemList } from '@/components/ui/lists/ItemList';

export default function CodeServerSettingsRoute() {
    return <ItemList style={{ paddingTop: 0 }}><CodeServerReviewSettings /></ItemList>;
}
