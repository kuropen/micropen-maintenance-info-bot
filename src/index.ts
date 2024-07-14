import parse from 'rss-to-json'
import {api as MisskeyApi} from 'misskey-js'
import type { FeedEntry } from './types'
import type { FetchLike } from 'misskey-js/built/api'

const MICROPEN_HOST = 'https://mi.kuropen.org' as const
/**
 * ステータスページのホスト名
 */
const STATUS_PAGE_HOST = 'https://status.kuropen.org' as const
/**
 * ステータスページのドキュメントルート
 */
const STATUS_PAGE_DOCUMENT_ROOT = STATUS_PAGE_HOST + '/'

const PROCESSED_ENTRIES_KV_KEY = 'processed-entries' as const

const cloudflareFetch: FetchLike = async (input, init) => {
	// Cloudflare Workersのfetchは、initのcredentialsおよびcacheを実装していないため、
	// これらのオプションを削除してfetchを実行する
	delete init?.credentials
	delete init?.cache
	return await fetch(input, init)
}

export default {
	async scheduled(event, env, ctx): Promise<void> {
		// MICROPENに対して HEAD リクエストをし、失敗した場合は終了する
		const response = await fetch(MICROPEN_HOST, { method: 'HEAD' })
		if (!response.ok) {
			console.log('MICROPEN に接続できませんでした。')
			return
		}

		// Misskey APIクライアントの初期化
		const misskey = new MisskeyApi.APIClient({
			origin: MICROPEN_HOST,
			credential: env.MISSKEY_API_TOKEN,
			fetch: cloudflareFetch,
		})

		// ステータスページに対して HEAD リクエストをし、失敗した場合は終了する
		const statusPageResponse = await fetch(STATUS_PAGE_HOST, { method: 'HEAD' })
		if (!statusPageResponse.ok) {
			console.log('ステータスページに接続できませんでした。')
			return
		}

		// 処理済みのエントリを取得
		const processedEntryList = await env.INFOBOT_KV.get(PROCESSED_ENTRIES_KV_KEY)
		const processedEntries = processedEntryList?.split(',') ?? []

		// フィードからエントリを取得
		const feedEntries = await parse(STATUS_PAGE_HOST + '/feed')

		const newProcessedEntries: string[] = processedEntries

		const feedEntriesToProcess = feedEntries.items.filter((entry: FeedEntry) => {
			// URLがドキュメントルートの場合はメンテナンス告知や障害レポートではないので除外
			if (entry.link === STATUS_PAGE_DOCUMENT_ROOT) {
				return false
			}

			// タイトルに MICROPEN または Misskey の文字が含まれているエントリのみを取得
			if (!(entry.title.includes('MICROPEN') || entry.title.includes('Misskey'))) {
				return false
			}

			const entryId = entry.link.split('/').pop()
			const entryUniqueKey = `${entryId}-${entry.published}`

			// 既に処理済みのエントリは除外する
			if (processedEntries.includes(entryUniqueKey)) {
				return false
			}

			// 処理済みのエントリリストに追加
			newProcessedEntries.push(entryUniqueKey)

			// published が 1時間以内のエントリのみをメッセージに含める
			const now = Date.now()
			const oneHourAgo = now - 60 * 60 * 1000
			if (entry.published < oneHourAgo) {
				return false
			}

			return true
		})

		// 処理済みのエントリリストを保存
		// 空文字列の混入防止のため、0件ならキーを削除
		if (newProcessedEntries.length > 0) {
			await env.INFOBOT_KV.put(PROCESSED_ENTRIES_KV_KEY, newProcessedEntries.join(','))
		} else {
			await env.INFOBOT_KV.delete(PROCESSED_ENTRIES_KV_KEY)
		}

		const promises = feedEntriesToProcess.map(async (entry: FeedEntry) => {
			const description = entry.description === 'Maintenance completed' ? 'このメンテナンスは完了しました。' : 'メンテナンス・障害情報が更新されました。'
			const message = `【メンテナンス・障害情報】\n${entry.title}\n${description}\n${entry.link}`
			return misskey.request('notes/create', {
				text: message,
				visibility: 'home',
			})
		})
		const results = await Promise.all(promises)

		console.log(results)
	},
} satisfies ExportedHandler<Env>;
