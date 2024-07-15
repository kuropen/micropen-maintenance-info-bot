/*!
 * MICROPEN maintenance info bot
 * Copyright (C) 2024 Kuropen (Hirochika Yuda) https://kuropen.org/
 */

import parse from 'rss-to-json'
import { parseFromString } from 'dom-parser'
import {api as MisskeyApi} from 'misskey-js'
import type { FeedEntry } from './types'
import type { FetchLike } from 'misskey-js/built/api'

/**
 * APIクライアントに渡すfetch関数
 * @param input 
 * @param init 
 * @returns 
 */
const cloudflareFetch: FetchLike = async (input, init) => {
	// Cloudflare Workersのfetchは、initのcredentialsおよびcacheを実装していないため、
	// これらのオプションを削除してfetchを実行する
	delete init?.credentials
	delete init?.cache
	return await fetch(input, init)
}

const run = async (env: Env) => {
	const {SERVICE_HOST, STATUS_PAGE_HOST, PROCESSED_ENTRIES_KV_KEY, SERVICE_NAME, PLATFORM_NAME} = env
	const SERVICE_ROOT = SERVICE_HOST + '/'
	const STATUS_PAGE_DOCUMENT_ROOT = STATUS_PAGE_HOST + '/'

	// HEAD リクエストをし、失敗した場合は終了する
	const response = await fetch(SERVICE_ROOT, { method: 'HEAD' })
	if (!response.ok) {
		console.log(`${SERVICE_NAME}に接続できませんでした。`)
		return
	}

	// Misskey APIクライアントの初期化
	const misskey = new MisskeyApi.APIClient({
		origin: SERVICE_HOST,
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

		// タイトルにサービス名またはプラットフォーム名の文字が含まれているエントリのみを取得
		if (!(entry.title.includes(PLATFORM_NAME) || entry.title.includes(SERVICE_NAME))) {
			return false
		}

		const entryId = entry.link.split('/').pop()
		const entryUniqueKey = `${entryId}-${entry.published}`

		if (!env.TEST_MODE) {
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
		const pageFetch = await fetch(entry.link)
		const originalHtml = await pageFetch.text()
		// DOCTYPEタグによるバグ回避: see https://github.com/ershov-konst/dom-parser/pull/35
		const html = originalHtml.replace('<!DOCTYPE html>', '')
		const dom = parseFromString(html)

		let entryTypeBox = dom.getElementsByClassName('text-statuspage-blue')[0] || dom.getElementsByClassName('text-statuspage-yellow')[0] || dom.getElementsByClassName('text-statuspage-red')[0]
		const entryType = entryTypeBox?.textContent

		let entryTypeJp
		if (!entryType) {
			entryTypeJp = 'お知らせ'
		} else {
			switch (entryType) {
				case 'Downtime':
				case 'Degraded':
					entryTypeJp = '障害情報'
					break
				case 'Maintenance':
					entryTypeJp = 'メンテナンス情報'
					break
			}
		}

		const description = dom.getElementsByClassName('prose-sm')[0]?.textContent || '詳細はリンク先をご確認ください。'
		const message = `【${entryTypeJp}】\n${entry.title}\n${description}\n${entry.link}`
		
		if (env.TEST_MODE) {
			// TEST_MODE が有効な場合は投稿しない
			return message
		}
		return misskey.request('notes/create', {
			text: message,
			visibility: 'home',
		})
	})

	return Promise.all(promises)
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url)
		const { pathname } = url

		if (pathname === '/test-run' && env.ALLOW_EXEC_VIA_HTTP) {
			const result = await run(env)
			return Response.json(result)
		}

		// 死活監視用のため、テキストを返すだけ
		return new Response('The bot is alive.', {
			headers: {
				'content-type': 'text/plain',
			},
		})
	},

	async scheduled(event, env, ctx): Promise<void> {
		console.log(await run(env))
	},
} satisfies ExportedHandler<Env>;
