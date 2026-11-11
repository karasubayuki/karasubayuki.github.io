# encoding: UTF-8

# Run after the reader generator so its HTML entry pages are included as well.
module SiteMap
  class Generator < Jekyll::Generator
    safe true
    priority :lowest

    def generate(site)
      return unless site.config['sitemap'] == true

      pages = site.pages + site.documents.select(&:write?)
      paths = pages.select do |page|
        page.output_ext == '.html' && page.data['sitemap'] != false && page.data['published'] != false
      end.map(&:url).uniq.sort

      page = Jekyll::PageWithoutAFile.new(site, site.source, '', 'sitemap.xml')
      page.data = {'layout' => nil, 'permalink' => '/sitemap.xml', 'sitemap' => false, 'paths' => paths}
      # Jekyll's URL filter handles the canonical host, baseurl and URL escaping.
      # No lastmod is emitted: a build date is not a page modification date.
      page.content = <<~XML
        <?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        {% for path in page.paths %}  <url><loc>{{ path | absolute_url | xml_escape }}</loc></url>
        {% endfor %}</urlset>
      XML
      site.pages << page
    end
  end
end
