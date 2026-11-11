# encoding: UTF-8
require 'cgi'
require 'json'
require 'digest'

# Render Markdown once; ship a small inline start and one complete background bundle.
module ReadingPages
  class Generator < Jekyll::Generator
    safe true
    priority :low

    VOID_TAGS = %w[area base br col embed hr img input link meta param source track wbr].freeze
    HTML_TOKEN = /<!--.*?-->|<(?:\/?[A-Za-z](?:"[^"]*"|'[^']*'|[^'">])*|![^>]*)>|[^<]+|</m

    def generate(site)
      collection = site.collections['texts']
      return unless collection

      collection.metadata['output'] = false
      occupied = (site.pages + site.static_files + site.collections.values.flat_map(&:docs).select(&:write?))
                 .to_h { |item| [File.expand_path(item.destination(site.dest)).downcase, true] }
      collection.docs.each do |doc|
        next if doc.data['published'] == false || doc.date > site.time

        root = doc.url
        address = doc.data['permalink'] || Jekyll::URL.unescape_path(root)
        unless address.is_a?(String) && address.match?(%r{\A/(?:[\p{L}\p{N}_-]+/)+\z}u)
          fail_build(doc, 'Адрес текста должен начинаться и заканчиваться / и содержать только буквы, цифры, дефисы и подчёркивания.')
        end
        settings = {}
        {'lines_per_page_desktop' => 40, 'lines_per_page_mobile' => 30}.each do |key, fallback|
          value = doc.data.fetch(key, fallback)
          fail_build(doc, "#{key}: задайте положительное целое число.") unless value.is_a?(Integer) && value.positive?
          settings[key] = value
        end
        renderer = Jekyll::Renderer.new(site, doc)
        payload = site.site_payload
        payload['page'] = doc.to_liquid
        markdown = renderer.render_liquid(doc.content, payload, {registers: {site: site, page: payload['page']}}, doc.path)
        blocks = html_blocks(reading_html(markdown, renderer, site)).each_with_index.flat_map { |html, index| bounded_parts(html, index) }
        fail_build(doc, 'Опубликованный текст пуст.') if blocks.empty?
        work_name = doc.data['work'].to_s.strip
        work_name = source_name(doc, '_texts/') if work_name.empty?
        work = site.collections['works']&.docs&.find do |candidate|
          source_name(candidate, '_works/') == work_name && candidate.data['published'] != false && candidate.date <= site.time
        end
        fail_build(doc, "Не найдено опубликованное произведение #{work_name}. Укажите его имя в поле work.") unless work

        anchors = {}
        blocks.each_with_index do |part, index|
          part['html'].scan(/\bid=(?:"([^"]*)"|'([^']*)')/).each do |a, b|
            anchors[CGI.unescapeHTML(a || b)] ||= index
          end
        end
        revision = Digest::SHA256.hexdigest(JSON.generate([settings, anchors, blocks]))
        manifest = {'format' => 'reading-bundle-v2', **settings, 'anchors' => anchors,
                    'revision' => revision, 'part_count' => blocks.length, 'parts' => blocks}
        initial, characters = [], 0
        blocks.each do |part|
          initial << part
          characters += CGI.unescapeHTML(part['html'].gsub(/<[^>]*>/, '')).length
          break if characters >= settings.values.max * 160
        end
        # Escape '<' so a literal closing script tag in a work cannot end the data element.
        bootstrap = JSON.generate(manifest.merge('parts' => initial)).gsub('<') { '\\u003c' }
        add_page(site, doc, occupied, root, 'content.json', JSON.generate(manifest),
                 'layout' => nil, 'render_with_liquid' => false)
        add_page(site, doc, occupied, root, 'index.html', '',
                 doc.data.merge(settings).merge('layout' => 'text', 'permalink' => root,
                   'text_source' => doc.relative_path, 'text_manifest' => "#{root}content.json?v=#{revision}",
                   'text_bootstrap' => bootstrap, 'work_url' => work.url))
      end
    end

    private

    def source_name(doc, prefix)
      doc.relative_path.delete_prefix(prefix).sub(/\.[^.]+\z/, '')
    end

    def add_page(site, doc, occupied, directory, name, content, data)
      page = Jekyll::PageWithoutAFile.new(site, site.source, directory.delete_prefix('/'), name)
      page.content = content
      page.data = data
      key = File.expand_path(page.destination(site.dest)).downcase
      fail_build(doc, "Адрес #{page.url} уже занят другим материалом.") if occupied[key]
      occupied[key] = true
      site.pages << page
    end

    def fail_build(doc, message)
      raise Jekyll::Errors::FatalException, "#{doc.relative_path}: #{message}"
    end

    def reading_html(markdown, renderer, site)
      # Initialize the project's converter and reuse its normalized Kramdown options.
      renderer.convert('')
      document = Kramdown::JekyllDocument.new(markdown, site.config.fetch('kramdown', {}))
      original = document.root.children
      document.root.children = original.each_with_index.flat_map do |element, index|
        if element.type == :p
          split_inline(element.children).each_with_index.filter_map do |children, part|
            next if children.empty?
            copy = copy_element(element, children)
            copy.attr.delete('id') if part.positive?
            copy
          end
        elsif element.type == :hr
          before = index.positive? && original[index - 1].type == :blank ? original[index - 1].value.count("\n") : 0
          after = original[index + 1]&.type == :blank ? original[index + 1].value.count("\n") : 0
          wrapper = Kramdown::Element.new(:html_element, 'div',
            {'class' => 'reading-break', 'style' => "--reading-blank-before: #{before}; --reading-blank-after: #{after}"},
            category: :block, content_model: :block)
          wrapper.children = [element]
          wrapper
        else
          element
        end
      end
      document.to_html
    end

    def copy_element(element, children)
      copy = Kramdown::Element.new(element.type, element.value, element.attr.dup, element.options.dup)
      copy.children = children
      copy
    end

    # Split only prose paragraphs. Markdown block structures retain their semantics.
    # Inline markup crossing a source newline is cloned into both new paragraphs.
    def split_inline(elements)
      groups = [[]]
      elements.each do |element|
        if element.type == :text
          element.value.split("\n", -1).each_with_index do |value, index|
            groups << [] if index.positive?
            groups.last << Kramdown::Element.new(:text, value) unless value.empty?
          end
        elsif element.type == :br
          groups << []
        elsif !element.children.empty?
          split_inline(element.children).each_with_index do |children, index|
            groups << [] if index.positive?
            next if children.empty?
            copy = copy_element(element, children)
            copy.attr.delete('id') if index.positive?
            groups.last << copy
          end
        else
          groups.last << element
        end
      end
      groups
    end

    # Preserve the converter's HTML, including global links, footnotes and IDs.
    # Standalone HTML comments have no pagination meaning.
    def html_blocks(html)
      blocks, stack, buffer = [], [], +''
      html.scan(HTML_TOKEN).each do |token|
        next if stack.empty? && (token.strip.empty? || token.start_with?('<!--'))
        buffer << token
        if (closing = token.match(%r{\A</([\w:-]+)}))
          index = stack.rindex(closing[1].downcase)
          stack.slice!(index..) if index
        elsif (opening = token.match(/\A<([\w:-]+)/))
          tag = opening[1].downcase
          stack << tag unless VOID_TAGS.include?(tag) || token.end_with?('/>')
        end
        if stack.empty?
          blocks << buffer unless buffer.strip.empty?
          buffer = +''
        end
      end
      blocks << buffer unless buffer.strip.empty?
      blocks
    end

    # Balance wrappers at chunk boundaries; the reader rejoins them before measuring.
    # Even a book written as one paragraph is loaded in bounded pieces.
    def bounded_parts(html, block)
      parts, stack, buffer, size, depth = [], [], +'', 0, 0
      flush = lambda do
        closing = stack.reverse.map { |tag, _| "</#{tag}>" }.join
        parts << {'html' => buffer + closing, 'block' => block, 'join_depth' => depth}
        buffer = stack.map(&:last).join
        size = 0
        depth = stack.size
      end
      html.scan(HTML_TOKEN).each do |token|
        if token.start_with?('<')
          buffer << token
          if (closing = token.match(%r{\A</([\w:-]+)}))
            index = stack.rindex { |tag, _| tag == closing[1].downcase }
            stack.slice!(index..) if index
          elsif (opening = token.match(/\A<([\w:-]+)/))
            tag = opening[1].downcase
            if VOID_TAGS.include?(tag) || token.end_with?('/>')
              size += 1
            else
              stack << [tag, token]
            end
          end
        else
          token.scan(/&(?:\#\d+|\#x[\da-f]+|\w+);|\X/i).each do |character|
            buffer << character
            size += 1
            flush.call if size >= 4096 && (character.match?(/\s/) || size >= 4160)
          end
        end
      end
      flush.call if size.positive? || parts.empty?
      parts
    end
  end
end
